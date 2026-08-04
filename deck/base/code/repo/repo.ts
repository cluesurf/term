import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import {
  readCommit,
  writeCommit,
  signCommitObject,
  parseCommit,
  type Commit,
} from '@term/base/code/commit/commit'
import type {
  RemoteRepo,
  PushResult,
  PullResult,
} from '@term/base/code/transport/session'
import { writeChanges, readChanges } from '@term/base/code/commit/changeset'
import type { Keypair } from '@term/base/code/access/sign'
import { emptyDataset, type Dataset } from '@term/base/code/diff/change'
import { diffDataset } from '@term/base/code/diff/diff'
import type { RoleBase } from '@term/base/code/form/form'
import { errors as holdErrors, validateDataset, type Diagnostic } from '@term/base/code/form/validate'
import { mergeDataset, type Conflict, type MergeOptions } from '@term/base/code/merge/merge'
import { policyResolver } from '@term/base/code/merge/policy'
import { autoMark } from '@term/base/code/form/automark'
import { AccessPolicy, authorizeCommit } from '@term/base/code/access/policy'
import { isPrunable, type ChunkStore } from '@term/base/code/store/chunk-store'
import type { RefStore } from '@term/base/code/store/ref-store'
import { diffRoots, readDataset, readRecord, treeNodeRefs, updateTree, writeDataset } from '@term/base/code/store/tree'
import { reachableChunks, sweep, type GcReport } from '@term/base/code/gc/gc'
import { fsck, type FsckReport } from '@term/base/code/verify/fsck'
import {
  ConcurrentErasureError,
  type Eraser,
  type EraseReport,
} from '@term/base/code/erase/erase'
import {
  isOffHistoryRef,
  offHistoryId,
  type OffHistoryStore,
} from '@term/base/code/offhistory/store'
import { RevocationList } from '@term/base/code/erase/revocation'
import { hashRecord } from '@term/base/code/canon/hash'
import type { RefLog, RefLogEntry } from '@term/base/code/reflog/reflog'
import type { Mark, RecordNode, Value } from '@term/base/code/base/type'
import type { Change } from '@term/base/code/diff/change'

// The repository ties the store, the refs, and commits into a version-control
// system. The commit is gated by validation and lands via compare-and-swap on the
// branch head, with an automatic semantic rebase-merge on contention. The
// prolly-tree store plus the ref store is the source of truth; a database
// projection (elsewhere) is a rebuildable cache.
//
// See note/library/base/15-architecture-and-components.md and
// note/library/base/design/consistency-and-concurrency.md.

export type CommitMeta = {
  author: string
  time: number
  message: string
  reason?: string
  sources?: Array<string>
  // the acting user, checked against the policy if one is configured
  user?: string
}

export type RepoOptions = {
  // if set, a commit requires the meta.user to hold `commit` on the branch
  policy?: AccessPolicy
  // if set, unmarked instances of base forms are auto-marked before commit
  autoMark?: boolean
  // if set, every commit is signed with this ed25519 keypair
  signer?: Keypair
  // if set, every ref move is recorded here for recovery
  reflog?: RefLog
}

export type CommitResult =
  | { ok: true; commit: string; diagnostics: Array<Diagnostic> }
  | { ok: false; diagnostics?: Array<Diagnostic>; conflicts?: Array<Conflict> }

export type MergeResultOut =
  | { ok: true; commit: string; alreadyUpToDate?: boolean }
  | { ok: false; conflicts: Array<Conflict> }

const MAX_CAS_RETRIES = 8

function refName(branch: string): string {
  return `branch/${branch}`
}

function tagRefName(name: string): string {
  return `tag/${name}`
}

export class Repository {
  constructor(
    private readonly chunks: ChunkStore,
    private readonly refs: RefStore,
    private readonly role?: RoleBase,
    private readonly opts: RepoOptions = {},
  ) {}

  // Move a ref by compare-and-swap, recording the move in the reflog on success so it
  // is recoverable. Every ref-moving operation goes through here.
  private moveRef(
    name: string,
    from: string | undefined,
    to: string,
    op: string,
    message: string,
    time: number,
  ): boolean {
    const ok = this.refs.compareAndSwap(name, from, to)
    if (ok && this.opts.reflog !== undefined) {
      this.opts.reflog.record({ ref: name, from, to, op, message, time })
    }
    return ok
  }

  head(branch: string): string | undefined {
    return this.refs.get(refName(branch))
  }

  // The reflog entries for a branch, newest first (empty if no reflog is configured).
  reflog(branch: string): Array<RefLogEntry> {
    return this.opts.reflog?.entries(refName(branch)) ?? []
  }

  branches(): Array<string> {
    return this.refs
      .list()
      .filter(n => n.startsWith('branch/'))
      .map(n => n.slice('branch/'.length))
  }

  readCommit(hash: string): Commit {
    return readCommit(hash, this.chunks)
  }

  // The field-level change set a commit recorded, or undefined if it stored none.
  commitChangeset(hash: string): Array<Change> | undefined {
    const changes = readCommit(hash, this.chunks).changes
    return changes === undefined ? undefined : readChanges(changes, this.chunks)
  }

  // The dataset at a commit.
  checkout(commit: string): Dataset {
    return readDataset(readCommit(commit, this.chunks).root, this.chunks)
  }

  // One record as of a commit, by point lookup in the tree (no full checkout).
  recordAt(commit: string, mark: string): RecordNode | undefined {
    return readRecord(readCommit(commit, this.chunks).root, mark, this.chunks)
  }

  // The dataset at a branch head, or empty if the branch does not exist.
  checkoutBranch(branch: string): Dataset {
    const head = this.head(branch)
    return head ? this.checkout(head) : emptyDataset()
  }

  private validate(dataset: Dataset): {
    diagnostics: Array<Diagnostic>
    blocked: boolean
  } {
    if (!this.role) {
      return { diagnostics: [], blocked: false }
    }
    const diagnostics = validateDataset(dataset, this.role)
    return { diagnostics, blocked: holdErrors(diagnostics).length > 0 }
  }

  // Merge options carrying the role's per-field merge policies, so concurrent edits are
  // resolved according to each field's declared concurrency contract.
  private mergeOpts(): MergeOptions {
    return this.role ? { policy: policyResolver(this.role) } : {}
  }

  // Build the new record-tree root incrementally from the parent, so only changed
  // records are canonicalized and hashed, not the whole dataset.
  private rootFor(
    parentRoot: string,
    changes: Array<Change>,
    desired: Dataset,
  ): string {
    const upserts = new Map<Mark, RecordNode>()
    const removes = new Set<Mark>()
    for (const ch of changes) {
      const r = desired.get(ch.mark)
      if (r) {
        upserts.set(ch.mark, r)
      } else {
        removes.add(ch.mark)
      }
    }
    return updateTree(parentRoot, upserts, removes, this.chunks)
  }

  private buildCommit(
    root: string,
    parents: Array<string>,
    meta: CommitMeta,
    diagnostics: Array<Diagnostic>,
    changes: Array<Change>,
  ): string {
    const commit: Commit = {
      root,
      parents,
      author: meta.author,
      time: meta.time,
      message: meta.message,
      validation: {
        schema: 'passed',
        errors: holdErrors(diagnostics).length,
        warnings: diagnostics.length - holdErrors(diagnostics).length,
      },
      // record the exact change set as its own chunk so readers never re-diff
      changes: writeChanges(changes, this.chunks),
    }
    if (meta.reason !== undefined) {
      commit.reason = meta.reason
    }
    if (meta.sources !== undefined) {
      commit.sources = meta.sources
    }
    const finished = this.opts.signer
      ? signCommitObject(commit, this.opts.signer)
      : commit
    return writeCommit(finished, this.chunks)
  }

  // Commit a new full dataset to a branch. Validation gates it; if it passes, the
  // commit lands via compare-and-swap, and on contention it three-way merges with
  // the advanced head and retries. Returns conflicts if a concurrent edit collides.
  commit(branch: string, meta: CommitMeta, next: Dataset): CommitResult {
    // access control: if a policy is set, the acting user must hold commit rights
    if (this.opts.policy && meta.user !== undefined) {
      if (!authorizeCommit(this.opts.policy, meta.user, branch)) {
        return {
          ok: false,
          diagnostics: [
            {
              severity: 'hold',
              mark: undefined,
              field: undefined,
              message: `user ${meta.user} lacks commit on branch ${branch}`,
            },
          ],
        }
      }
    }

    // auto-mark unmarked base-form instances before validating
    const working =
      this.opts.autoMark && this.role ? autoMark(next, this.role).dataset : next

    const check = this.validate(working)
    if (check.blocked) {
      return { ok: false, diagnostics: check.diagnostics }
    }

    let head = this.head(branch)
    let base = head ? this.checkout(head) : emptyDataset()
    let desired = working

    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const changes = diffDataset(base, desired)
      if (changes.length === 0 && head !== undefined) {
        return { ok: true, commit: head, diagnostics: check.diagnostics }
      }
      const parentRoot = head
        ? readCommit(head, this.chunks).root
        : undefined
      const root =
        parentRoot !== undefined
          ? this.rootFor(parentRoot, changes, desired)
          : writeDataset(desired, this.chunks)
      const commitHash = this.buildCommit(
        root,
        head ? [head] : [],
        meta,
        check.diagnostics,
        changes,
      )
      if (this.moveRef(refName(branch), head, commitHash, 'commit', meta.message, meta.time)) {
        return { ok: true, commit: commitHash, diagnostics: check.diagnostics }
      }
      // head advanced under us: three-way merge our change onto the new head
      const newHead = this.head(branch)!
      const theirs = this.checkout(newHead)
      const { merged, conflicts } = mergeDataset(base, desired, theirs, this.mergeOpts())
      if (conflicts.length > 0) {
        return { ok: false, conflicts }
      }
      // validate the merged result: a merge can create an invariant violation (e.g. two
      // branches introduce the same unique value) that neither side had on its own
      const postMerge = this.validate(merged)
      if (postMerge.blocked) {
        return { ok: false, diagnostics: postMerge.diagnostics }
      }
      head = newHead
      base = theirs
      desired = merged
    }
    return { ok: false, diagnostics: check.diagnostics }
  }

  // Create a new branch pointing at a commit (or at another branch's head).
  createBranch(name: string, from: { commit?: string; branch?: string }): boolean {
    const target = from.commit ?? (from.branch ? this.head(from.branch) : undefined)
    if (target === undefined) {
      return false
    }
    return this.moveRef(refName(name), undefined, target, 'branch', `branch ${name}`, 0)
  }

  // Force a branch to point at a commit, recording the move so the prior head stays
  // recoverable. This is the recovery primitive: reset to a hash read from the reflog.
  resetBranch(branch: string, to: string, message = 'reset'): boolean {
    const from = this.head(branch)
    return this.moveRef(refName(branch), from, to, 'reset', message, 0)
  }

  // Tag a commit with an immutable name, for a citeable release. Fails if the tag
  // already exists, since a release must not move.
  createTag(name: string, commit: string): boolean {
    return this.moveRef(tagRefName(name), undefined, commit, 'tag', `tag ${name}`, 0)
  }

  // The commit a tag names, or undefined.
  tag(name: string): string | undefined {
    return this.refs.get(tagRefName(name))
  }

  tags(): Array<string> {
    return this.refs
      .list()
      .filter(n => n.startsWith('tag/'))
      .map(n => n.slice('tag/'.length))
  }

  private tagTargets(): Array<string> {
    const out: Array<string> = []
    for (const name of this.tags()) {
      const c = this.tag(name)
      if (c !== undefined) {
        out.push(c)
      }
    }
    return out
  }

  // Every movable ref (branch and tag) with its current hash. Used by erasure, which
  // must rewrite them all.
  private movableRefs(): Array<{ name: string; hash: string }> {
    const out: Array<{ name: string; hash: string }> = []
    for (const name of this.refs.list()) {
      if (name.startsWith('branch/') || name.startsWith('tag/')) {
        const hash = this.refs.get(name)
        if (hash !== undefined) {
          out.push({ name, hash })
        }
      }
    }
    return out
  }

  private ancestors(commit: string): Set<string> {
    const out = new Set<string>()
    const stack = [commit]
    while (stack.length) {
      const c = stack.pop()!
      if (out.has(c)) {
        continue
      }
      out.add(c)
      for (const p of readCommit(c, this.chunks).parents) {
        stack.push(p)
      }
    }
    return out
  }

  // Lowest common ancestor of two commits, or undefined if none.
  private lca(a: string, b: string): string | undefined {
    const ancA = this.ancestors(a)
    const seen = new Set<string>()
    const queue = [b]
    while (queue.length) {
      const c = queue.shift()!
      if (seen.has(c)) {
        continue
      }
      seen.add(c)
      if (ancA.has(c)) {
        return c
      }
      for (const p of readCommit(c, this.chunks).parents) {
        queue.push(p)
      }
    }
    return undefined
  }

  // Merge a source branch into a target branch. Auto-merges independent changes and
  // returns conflicts when the same field diverged. Records a two-parent commit.
  merge(
    target: string,
    source: string,
    meta: CommitMeta,
  ): MergeResultOut {
    const th = this.head(target)
    const sh = this.head(source)
    if (sh === undefined) {
      return { ok: false, conflicts: [] }
    }
    if (th === undefined) {
      this.moveRef(refName(target), undefined, sh, 'merge', meta.message, meta.time)
      return { ok: true, commit: sh, alreadyUpToDate: true }
    }
    if (th === sh || this.ancestors(th).has(sh)) {
      return { ok: true, commit: th, alreadyUpToDate: true }
    }
    const baseCommit = this.lca(th, sh)
    const baseDS = baseCommit ? this.checkout(baseCommit) : emptyDataset()
    const targetDS = this.checkout(th)
    const sourceDS = this.checkout(sh)
    const { merged, conflicts } = mergeDataset(baseDS, targetDS, sourceDS, this.mergeOpts())
    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }
    if (this.validate(merged).blocked) {
      return { ok: false, conflicts: [] } // merge would violate an invariant
    }
    const root = writeDataset(merged, this.chunks)
    // the merge commit's change set is what it added on top of the target branch
    const mergeChanges = diffDataset(targetDS, merged)
    const commitHash = this.buildCommit(root, [th, sh], meta, [], mergeChanges)
    this.moveRef(refName(target), th, commitHash, 'merge', meta.message, meta.time)
    return { ok: true, commit: commitHash }
  }

  // The state before and at a commit, for applying its change semantically.
  private beforeAndAt(commit: string): { before: Dataset; at: Dataset } {
    const c = readCommit(commit, this.chunks)
    const parent = c.parents[0]
    return {
      before: parent !== undefined ? this.checkout(parent) : emptyDataset(),
      at: this.checkout(commit),
    }
  }

  // Apply one commit's change onto a branch, as a semantic three-way merge (the change
  // is the difference between the commit's parent and the commit). Field-level, so it
  // applies cleanly even where the surrounding record has moved on, unlike a text patch.
  cherryPick(branch: string, commit: string, meta: CommitMeta): CommitResult {
    const { before, at } = this.beforeAndAt(commit)
    const target = this.checkoutBranch(branch)
    const { merged, conflicts } = mergeDataset(before, target, at, this.mergeOpts())
    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }
    return this.commit(branch, meta, merged)
  }

  // Undo an actor's most recent commit on a branch, as a compensating revert rather than
  // erasing history. In multiplayer, undo means undo my last action, not the global last
  // one, so this finds the newest commit authored by the actor and reverts it.
  undoLast(branch: string, actor: string, meta: CommitMeta): CommitResult {
    const mine = this.log(branch).find(entry => entry.commit.author === actor)
    if (mine === undefined) {
      return { ok: false, diagnostics: [] }
    }
    return this.revert(branch, mine.hash, meta)
  }

  // Apply the inverse of a commit onto a branch (undo it), again as a three-way merge
  // with the sides swapped, so it undoes exactly that commit's field-level change.
  revert(branch: string, commit: string, meta: CommitMeta): CommitResult {
    const { before, at } = this.beforeAndAt(commit)
    const target = this.checkoutBranch(branch)
    const { merged, conflicts } = mergeDataset(at, target, before, this.mergeOpts())
    if (conflicts.length > 0) {
      return { ok: false, conflicts }
    }
    return this.commit(branch, meta, merged)
  }

  // Replay a branch's unique commits onto another branch's head. Resets the branch to
  // `onto` and cherry-picks each replayed commit in order, preserving its authorship.
  rebase(
    branch: string,
    onto: string,
  ): { ok: true; replayed: number } | { ok: false; conflicts: Array<Conflict> } {
    const branchHead = this.head(branch)
    const ontoHead = this.head(onto)
    if (branchHead === undefined || ontoHead === undefined) {
      return { ok: true, replayed: 0 }
    }
    const ontoAncestors = this.ancestors(ontoHead)
    const toReplay: Array<string> = []
    let c: string | undefined = branchHead
    while (c !== undefined && !ontoAncestors.has(c)) {
      toReplay.push(c)
      c = readCommit(c, this.chunks).parents[0]
    }
    toReplay.reverse() // oldest first

    this.resetBranch(branch, ontoHead, 'rebase')
    let replayed = 0
    for (const commit of toReplay) {
      const orig = readCommit(commit, this.chunks)
      const res = this.cherryPick(branch, commit, {
        author: orig.author,
        time: orig.time,
        message: orig.message,
      })
      if (!res.ok) {
        return { ok: false, conflicts: res.conflicts ?? [] }
      }
      replayed++
    }
    return { ok: true, replayed }
  }

  // Send the chunks under a commit to a remote, pruning any subtree the remote already
  // has (a chunk it holds implies its whole subtree, since sync transfers transitively).
  // So a push moves only the difference.
  private async transferToRemote(head: string, remote: RemoteRepo): Promise<number> {
    let sent = 0
    const seen = new Set<string>()
    const stack: Array<{ hash: string; kind: 'commit' | 'node' | 'record' }> = [
      { hash: head, kind: 'commit' },
    ]
    while (stack.length > 0) {
      const { hash, kind } = stack.pop()!
      if (seen.has(hash)) {
        continue
      }
      seen.add(hash)
      if (await remote.hasChunk(hash)) {
        continue // remote has this and its subtree
      }
      const bytes = this.chunks.get(hash)
      if (bytes === undefined) {
        continue
      }
      await remote.putChunk(bytes)
      sent++
      if (kind === 'commit') {
        const commit = parseCommit(bytes)
        stack.push({ hash: commit.root, kind: 'node' })
        if (commit.changes !== undefined) {
          stack.push({ hash: commit.changes, kind: 'record' })
        }
        for (const parent of commit.parents) {
          stack.push({ hash: parent, kind: 'commit' })
        }
      } else if (kind === 'node') {
        const { leaf, refs } = treeNodeRefs(bytes)
        for (const ref of refs) {
          stack.push({ hash: ref, kind: leaf ? 'record' : 'node' })
        }
      }
    }
    return sent
  }

  // Fetch the chunks under a remote commit into the local store, pruning any subtree the
  // local store already has, and re-hashing every chunk on receipt.
  private async fetchFromRemote(head: string, remote: RemoteRepo): Promise<number> {
    let got = 0
    const seen = new Set<string>()
    const stack: Array<{ hash: string; kind: 'commit' | 'node' | 'record' }> = [
      { hash: head, kind: 'commit' },
    ]
    while (stack.length > 0) {
      const { hash, kind } = stack.pop()!
      if (seen.has(hash)) {
        continue
      }
      seen.add(hash)
      if (this.chunks.has(hash)) {
        continue // we have this and its subtree
      }
      const bytes = await remote.getChunk(hash)
      if (bytes === undefined) {
        continue
      }
      const actual = this.chunks.put(bytes)
      if (actual !== hash) {
        throw new Error(`chunk integrity failure on fetch: claimed ${hash}, got ${actual}`)
      }
      got++
      if (kind === 'commit') {
        const commit = parseCommit(bytes)
        stack.push({ hash: commit.root, kind: 'node' })
        if (commit.changes !== undefined) {
          stack.push({ hash: commit.changes, kind: 'record' })
        }
        for (const parent of commit.parents) {
          stack.push({ hash: parent, kind: 'commit' })
        }
      } else if (kind === 'node') {
        const { leaf, refs } = treeNodeRefs(bytes)
        for (const ref of refs) {
          stack.push({ hash: ref, kind: leaf ? 'record' : 'node' })
        }
      }
    }
    return got
  }

  // Push a branch to a remote. Fast-forward only: if the remote head has diverged, the
  // push is rejected and the caller pulls first. Transfers only the missing chunks, then
  // advances the remote ref by compare-and-swap.
  async push(remote: RemoteRepo, branch: string): Promise<PushResult> {
    const localHead = this.head(branch)
    if (localHead === undefined) {
      return { ok: false, status: 'rejected', reason: 'no such local branch' }
    }
    const name = refName(branch)
    const remoteHead = await remote.getRef(name)
    if (remoteHead === localHead) {
      return { ok: true, status: 'up-to-date', transferred: 0 }
    }
    if (remoteHead !== undefined && !this.ancestors(localHead).has(remoteHead)) {
      return { ok: false, status: 'rejected', reason: 'remote has diverged; pull first' }
    }
    const transferred = await this.transferToRemote(localHead, remote)
    const ok = await remote.setRef(name, remoteHead, localHead)
    return ok
      ? { ok: true, status: 'fast-forward', transferred }
      : { ok: false, status: 'rejected', reason: 'remote moved during push' }
  }

  // Pull a branch from a remote. Fetches missing chunks, then fast-forwards if the local
  // head is behind, or three-way merges if the branch diverged, recording a merge commit.
  async pull(
    remote: RemoteRepo,
    branch: string,
    meta?: CommitMeta,
  ): Promise<PullResult> {
    const name = refName(branch)
    const remoteHead = await remote.getRef(name)
    if (remoteHead === undefined) {
      return { ok: true, status: 'up-to-date', transferred: 0 }
    }
    const localHead = this.head(branch)
    if (localHead === remoteHead) {
      return { ok: true, status: 'up-to-date', transferred: 0 }
    }
    const transferred = await this.fetchFromRemote(remoteHead, remote)

    if (localHead === undefined || this.ancestors(remoteHead).has(localHead)) {
      this.moveRef(name, localHead, remoteHead, 'pull', 'pull', meta?.time ?? 0)
      return { ok: true, status: 'fast-forward', commit: remoteHead, transferred }
    }

    // diverged: three-way merge the remote head into the local head
    const baseCommit = this.lca(localHead, remoteHead)
    const baseDS = baseCommit ? this.checkout(baseCommit) : emptyDataset()
    const localDS = this.checkout(localHead)
    const remoteDS = this.checkout(remoteHead)
    const { merged, conflicts } = mergeDataset(baseDS, localDS, remoteDS, this.mergeOpts())
    if (conflicts.length > 0) {
      return { ok: false, status: 'conflict', conflicts: conflicts.length }
    }
    if (this.validate(merged).blocked) {
      return { ok: false, status: 'conflict', conflicts: 0 } // merge violates an invariant
    }
    const root = writeDataset(merged, this.chunks)
    const changes = diffDataset(localDS, merged)
    const m = meta ?? { author: 'sync', time: 0, message: `merge ${branch} from remote` }
    const commitHash = this.buildCommit(root, [localHead, remoteHead], m, [], changes)
    this.moveRef(name, localHead, commitHash, 'pull', m.message, m.time)
    return { ok: true, status: 'merged', commit: commitHash, transferred }
  }

  // The first-parent commit history of a branch, newest first.
  log(branch: string): Array<{ hash: string; commit: Commit }> {
    const out: Array<{ hash: string; commit: Commit }> = []
    let c = this.head(branch)
    while (c !== undefined) {
      const commit = readCommit(c, this.chunks)
      out.push({ hash: c, commit })
      c = commit.parents[0]
    }
    return out
  }

  // Marks whose record differs between two commits.
  diffCommits(a: string, b: string): Set<string> {
    return diffRoots(
      readCommit(a, this.chunks).root,
      readCommit(b, this.chunks).root,
      this.chunks,
    )
  }

  // Field-level blame for one record: the fields as of a commit, with the values
  // shown in canonical form. (A fuller blame walks history per field; this returns
  // the current record for inspection.)
  showRecord(commit: string, mark: string): string | undefined {
    const ds = this.checkout(commit)
    const r = ds.get(mark)
    return r ? canonicalizeRecord(r) : undefined
  }

  // The commit hashes at each branch head.
  private branchHeads(): Array<string> {
    const heads: Array<string> = []
    for (const b of this.branches()) {
      const h = this.head(b)
      if (h !== undefined) {
        heads.push(h)
      }
    }
    return heads
  }

  // The garbage-collection roots: every branch head and every tag, so a tagged release
  // is never collected even after its branch moves on.
  private retainedRoots(): Array<string> {
    return [...this.branchHeads(), ...this.tagTargets()]
  }

  // Every chunk reachable from the given roots (default: all branch heads and tags).
  // This is the live set: what a garbage collection keeps. Exposed so a mirror (for
  // example an R2 object store) can be swept against the same set the local store uses.
  reachableChunkHashes(roots?: Array<string>): Set<string> {
    return reachableChunks(this.chunks, roots ?? this.retainedRoots())
  }

  // Verify the integrity of the whole object graph reachable from all refs: every
  // commit, tree node, record, and change set is re-hashed, and anything missing or
  // corrupt is reported. This is base's fsck.
  fsck(): FsckReport {
    return fsck(this.chunks, this.retainedRoots())
  }

  // Reclaim chunks not reachable from any retained commit. Roots default to every
  // branch head; pass explicit roots to keep additional commits (tags, releases) alive.
  // Requires a chunk store that supports enumeration and deletion.
  gc(opts: { roots?: Array<string> } = {}): GcReport {
    if (!isPrunable(this.chunks)) {
      throw new Error('chunk store does not support garbage collection (not prunable)')
    }
    return sweep(this.chunks, this.reachableChunkHashes(opts.roots))
  }

  // All commits reachable from the given heads.
  private reachableCommits(heads: Array<string>): Set<string> {
    const all = new Set<string>()
    for (const h of heads) {
      for (const a of this.ancestors(h)) {
        all.add(a)
      }
    }
    return all
  }

  // Topological order of a commit set, parents before children, computed iteratively so
  // a long history does not overflow the stack.
  private topoOrder(commits: Set<string>): Array<string> {
    const out: Array<string> = []
    const done = new Set<string>()
    const stack: Array<{ hash: string; expanded: boolean }> = [...commits].map(hash => ({
      hash,
      expanded: false,
    }))
    while (stack.length > 0) {
      const top = stack.pop()!
      if (done.has(top.hash)) {
        continue
      }
      if (top.expanded) {
        done.add(top.hash)
        out.push(top.hash)
        continue
      }
      stack.push({ hash: top.hash, expanded: true })
      for (const p of readCommit(top.hash, this.chunks).parents) {
        if (commits.has(p) && !done.has(p)) {
          stack.push({ hash: p, expanded: false })
        }
      }
    }
    return out
  }

  // Hard-erase content from all of history. Every commit on every branch is rebuilt with
  // the eraser applied to its records, which orphans the originals, then (unless
  // disabled) garbage collection sweeps the now-unreachable chunks, physically removing
  // the content. If an `offHistory` store is given, off-history content an erased record
  // referenced is deleted from it too, so the two-tier deletion is complete. Commit
  // hashes change, so this is for genuine erasure demands. Content that must keep a
  // stable hash should be crypto-shredded instead. Throws ConcurrentErasureError, having
  // deleted nothing, if a branch head moves during the rewrite.
  eraseFromHistory(
    erase: Eraser,
    opts: {
      collect?: boolean
      offHistory?: OffHistoryStore
      revocation?: RevocationList
    } = {},
  ): EraseReport {
    const branches = this.branches()
    // every ref (branch and tag) is rewritten, so a tagged release cannot keep erased
    // content alive: legal erasure overrides a tag's immutability
    const refs = this.movableRefs()
    const order = this.topoOrder(this.reachableCommits(refs.map(r => r.hash)))

    const mapping = new Map<string, string>() // old commit -> new commit
    const rewrittenDataset = new Map<string, Dataset>() // old commit -> rewritten dataset
    let erasedOccurrences = 0
    const offHistoryIds = new Set<string>()
    const revoked = new Set<string>() // content hashes of erased records

    for (const old of order) {
      const commit = readCommit(old, this.chunks)
      const dataset = readDataset(commit.root, this.chunks)
      const rewritten: Dataset = new Map()
      for (const [mark, node] of dataset) {
        const fate = erase(node)
        if (fate === 'keep') {
          rewritten.set(mark, node)
          continue
        }
        // the record is being removed or replaced: revoke its exact content so no peer
        // can push it back, and note any off-history content it referenced
        revoked.add(hashRecord(node))
        if (opts.offHistory !== undefined) {
          collectOffHistoryIds(node, offHistoryIds)
        }
        if (fate === 'remove') {
          erasedOccurrences++
          continue
        }
        rewritten.set(mark, fate) // replaced (e.g. tombstone)
        erasedOccurrences++
      }

      const newRoot = writeDataset(rewritten, this.chunks)
      const parentOld = commit.parents[0]
      const parentDataset =
        parentOld !== undefined
          ? rewrittenDataset.get(parentOld) ?? emptyDataset()
          : emptyDataset()
      const changes = diffDataset(parentDataset, rewritten)
      const newParents = commit.parents.map(p => mapping.get(p) ?? p)

      const rebuilt: Commit = {
        root: newRoot,
        parents: newParents,
        author: commit.author,
        time: commit.time,
        message: commit.message,
        validation: commit.validation,
        changes: writeChanges(changes, this.chunks),
      }
      if (commit.reason !== undefined) {
        rebuilt.reason = commit.reason
      }
      if (commit.sources !== undefined) {
        rebuilt.sources = commit.sources
      }
      const finished = this.opts.signer
        ? signCommitObject(rebuilt, this.opts.signer)
        : rebuilt
      const newHash = writeCommit(finished, this.chunks)
      mapping.set(old, newHash)
      rewrittenDataset.set(old, rewritten)
    }

    // Repoint every branch atomically-per-ref via compare-and-swap. If any head moved
    // under us, the erasure raced a commit: abandon it without deleting anything (the
    // rebuilt commits are unreachable garbage a later gc reclaims) so the caller retries.
    const moved: Array<{ branch: string; from: string; to: string }> = []
    const raced: Array<string> = []
    for (const { name, hash: from } of refs) {
      const to = mapping.get(from)
      if (to === undefined || !this.moveRef(name, from, to, 'erase', 'hard erasure', 0)) {
        raced.push(name)
        continue
      }
      moved.push({ branch: name, from, to })
    }
    if (raced.length > 0) {
      throw new ConcurrentErasureError(raced)
    }

    // now that no reachable commit references it, delete the off-history content
    let offHistoryDeleted = 0
    if (opts.offHistory !== undefined) {
      for (const id of offHistoryIds) {
        if (opts.offHistory.has(id)) {
          opts.offHistory.delete(id)
          offHistoryDeleted++
        }
      }
    }

    // record the revocation so replicas and mirrors honour the erasure on catch-up
    if (opts.revocation !== undefined) {
      opts.revocation.revoke(revoked)
    }

    const report: EraseReport = {
      branches,
      rewritten: order.length,
      erasedOccurrences,
      moved,
      offHistoryDeleted,
      revoked: [...revoked].sort(),
    }
    if (opts.collect !== false && isPrunable(this.chunks)) {
      report.gc = this.gc()
    }
    return report
  }
}

// Collect the off-history content ids a record references, recursing through
// collections and nested records, so an erasure can delete them from the side store.
function collectOffHistoryIds(node: RecordNode, into: Set<string>): void {
  const visit = (value: Value): void => {
    if (isOffHistoryRef(value)) {
      const id = offHistoryId(value)
      if (id !== undefined) {
        into.add(id)
      }
    } else if (value.kind === 'collection') {
      for (const it of value.items) {
        visit(it.value)
      }
    } else if (value.kind === 'record') {
      for (const v of value.record.fields.values()) {
        visit(v)
      }
    }
  }
  for (const v of node.fields.values()) {
    visit(v)
  }
}
