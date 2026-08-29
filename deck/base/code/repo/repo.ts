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
import { partitionSensitive } from '@term/base/code/offhistory/sensitive'
import { coalesce, materialize, type Segment } from '@term/base/code/live/draft'
import { encodeSegment, decodeSegment } from '@term/base/code/live/segment'
import type { Op } from '@term/base/code/sync/op-sync'
import { RevocationList } from '@term/base/code/erase/revocation'
import { hashRecord } from '@term/base/code/canon/hash'
import type { RefLog, RefLogEntry } from '@term/base/code/reflog/reflog'
import type { Mark, RecordNode, Value } from '@term/base/code/base/type'
import type { Change } from '@term/base/code/diff/change'
import {
  FORMAT_VERSION,
  settleFormat,
} from '@term/base/code/canon/format'

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
  // if set (with a role), a commit routes every `seal`-marked field value into this
  // side store before writing, so regulated plaintext never enters immutable history
  offHistory?: OffHistoryStore
}

export type CommitResult =
  | { ok: true; commit: string; diagnostics: Array<Diagnostic> }
  | { ok: false; diagnostics?: Array<Diagnostic>; conflicts?: Array<Conflict> }

export type MergeResultOut =
  | { ok: true; commit: string; alreadyUpToDate?: boolean }
  | { ok: false; conflicts: Array<Conflict> }

const MAX_CAS_RETRIES = 8

// How many recent reflog entries per ref are kept as GC roots. Bounds the recovery
// window so old history is still collectable while a recent reset / rebase / erase is
// recoverable.
const REFLOG_ROOT_LIMIT = 50

function refName(branch: string): string {
  return `branch/${branch}`
}

function tagRefName(name: string): string {
  return `tag/${name}`
}

// The ref that names a branch's live-draft `pending` segment chain tip. A separate
// ref namespace from `branch/`, so a draft's uncommitted work never appears as a
// branch head to history, packages, or the log.
const DRAFT_REF_PREFIX = 'draft/'

function draftRefName(branch: string): string {
  return `${DRAFT_REF_PREFIX}${branch}`
}

export class Repository {
  // Chunk hashes written but not yet reachable from a ref (an in-flight fetch), kept
  // out of a concurrent gc()'s reach so it cannot sweep them before the ref moves.
  private readonly pendingChunks = new Set<string>()

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
    // The canonical-form gate, before anything is written. A repository written under a
    // form this build does not read would get chunks addressed by different rules mixed
    // into one history, and neither side would report a version problem, because a hash
    // that disagrees looks exactly like corruption. Claiming on a repository that has no
    // version records what is already true rather than asserting something new.
    const format = settleFormat(this.refs)

    if (!format.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            severity: 'hold',
            mark: undefined,
            field: undefined,
            message: `repository canonical form ${format.version} is not readable by this build, which writes ${FORMAT_VERSION}`,
          },
        ],
      }
    }

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

    // Route `seal`-marked field values into the off-history side store BEFORE writing,
    // so regulated plaintext (a national id, a private note) never enters immutable
    // content-addressed history — the whole point of `seal`, which the commit path
    // previously bypassed, leaving the value permanently un-deletable. Validation above
    // ran on the real values; the stored records keep only off-history references, and
    // the diff / changeset are computed on those references too.
    const partitioned =
      this.opts.offHistory !== undefined && this.role !== undefined
        ? partitionSensitive(working, this.role, this.opts.offHistory).dataset
        : working

    let head = this.head(branch)
    let base = head ? this.checkout(head) : emptyDataset()
    let desired = partitioned

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
    const sh = this.head(source)
    if (sh === undefined) {
      return { ok: false, conflicts: [] }
    }
    // Retry on a lost compare-and-swap, exactly like commit: the target head can
    // move under us between reading it and advancing the ref, and ignoring the CAS
    // result would orphan the merge commit while falsely reporting success.
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const th = this.head(target)
      if (th === undefined) {
        if (this.moveRef(refName(target), undefined, sh, 'merge', meta.message, meta.time)) {
          return { ok: true, commit: sh, alreadyUpToDate: true }
        }
        continue // someone created the branch under us
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
      if (this.moveRef(refName(target), th, commitHash, 'merge', meta.message, meta.time)) {
        return { ok: true, commit: commitHash }
      }
      // target advanced under us: recompute against the new head
    }
    return { ok: false, conflicts: [] }
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

  // The chunks a commit / node references, as typed child descriptors. A record
  // chunk is terminal. Used by the transfer walks to know what to recurse into.
  private chunkChildren(
    bytes: string,
    kind: 'commit' | 'node' | 'record',
  ): Array<{ hash: string; kind: 'commit' | 'node' | 'record' }> {
    if (kind === 'commit') {
      const commit = parseCommit(bytes)
      const out: Array<{ hash: string; kind: 'commit' | 'node' | 'record' }> = [
        { hash: commit.root, kind: 'node' },
      ]
      if (commit.changes !== undefined) {
        out.push({ hash: commit.changes, kind: 'record' })
      }
      for (const parent of commit.parents) {
        out.push({ hash: parent, kind: 'commit' })
      }
      return out
    }
    if (kind === 'node') {
      const { leaf, refs } = treeNodeRefs(bytes)
      return refs.map(ref => ({
        hash: ref,
        kind: (leaf ? 'record' : 'node') as 'commit' | 'node' | 'record',
      }))
    }
    return []
  }

  // Order the chunks reachable from `head` so that every chunk comes AFTER all the
  // chunks it references (post-order over the object DAG). Writing in this order is
  // what keeps an interrupted transfer safe: a referencing chunk is only stored once
  // its whole subtree is present, so presence-pruning ("has parent => has subtree")
  // stays sound and a crash leaves complete subtrees, never a parent with a missing
  // child that the next sync would skip forever. A subtree the destination already
  // holds is pruned. A required chunk missing from the SOURCE aborts, rather than
  // producing an incomplete destination whose ref would then be advanced.
  private async transferOrder(
    head: string,
    hasAtDestination: (hash: string) => Promise<boolean>,
    getFromSource: (hash: string) => Promise<string | undefined>,
  ): Promise<Array<{ hash: string; bytes: string }>> {
    const order: Array<{ hash: string; bytes: string }> = []
    const done = new Set<string>()
    type Frame = {
      hash: string
      kind: 'commit' | 'node' | 'record'
      expanded: boolean
      bytes?: string
    }
    const stack: Array<Frame> = [{ hash: head, kind: 'commit', expanded: false }]

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      if (!frame.expanded) {
        frame.expanded = true
        if (done.has(frame.hash)) {
          stack.pop()
          continue
        }
        if (await hasAtDestination(frame.hash)) {
          done.add(frame.hash) // destination has this and, transitively, its subtree
          stack.pop()
          continue
        }
        const bytes = await getFromSource(frame.hash)
        if (bytes === undefined) {
          throw new Error(
            `transfer aborted: source is missing chunk ${frame.hash}`,
          )
        }
        frame.bytes = bytes
        for (const child of this.chunkChildren(bytes, frame.kind)) {
          if (!done.has(child.hash)) {
            stack.push({ ...child, expanded: false })
          }
        }
      } else {
        stack.pop()
        if (!done.has(frame.hash)) {
          done.add(frame.hash)
          order.push({ hash: frame.hash, bytes: frame.bytes! })
        }
      }
    }
    return order
  }

  // Send the chunks under a commit to a remote, children before parents, pruning any
  // subtree the remote already has. So a push moves only the difference and an
  // interrupted push never poisons the remote (see transferOrder).
  private async transferToRemote(head: string, remote: RemoteRepo): Promise<number> {
    const order = await this.transferOrder(
      head,
      hash => remote.hasChunk(hash),
      async hash => this.chunks.get(hash),
    )
    for (const { bytes } of order) {
      await remote.putChunk(bytes)
    }
    return order.length
  }

  // Fetch the chunks under a remote commit into the local store, children before
  // parents, pruning any subtree the local store already has, and re-hashing every
  // chunk on receipt.
  private async fetchFromRemote(head: string, remote: RemoteRepo): Promise<Array<string>> {
    const order = await this.transferOrder(
      head,
      async hash => this.chunks.has(hash),
      hash => remote.getChunk(hash),
    )
    const fetched: Array<string> = []
    // A fetched chunk is not yet reachable from any ref, so a garbage collection that
    // runs (in this process) between the fetch and the ref move would sweep it.
    // Register each as a pending root while the fetch is in flight; the caller clears
    // them once the ref has moved. (Cross-PROCESS concurrent GC needs a store-level
    // write-time grace window instead — see the note on gc().)
    for (const { hash, bytes } of order) {
      const actual = this.chunks.put(bytes)
      if (actual !== hash) {
        throw new Error(`chunk integrity failure on fetch: claimed ${hash}, got ${actual}`)
      }
      this.pendingChunks.add(hash)
      fetched.push(hash)
    }
    return fetched
  }

  // Drop a fetch's chunks from the pending-root set once its ref has moved (or the
  // pull failed), so they are protected only for the window they are unreachable.
  private releasePending(hashes: Array<string>): void {
    for (const hash of hashes) {
      this.pendingChunks.delete(hash)
    }
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
    const fetched = await this.fetchFromRemote(remoteHead, remote)
    const transferred = fetched.length
    try {
      if (localHead === undefined || this.ancestors(remoteHead).has(localHead)) {
        // fast-forward. A lost CAS means the local branch moved under us, so this
        // pull did NOT land — report it raced rather than claim a false fast-forward.
        if (this.moveRef(name, localHead, remoteHead, 'pull', 'pull', meta?.time ?? 0)) {
          return { ok: true, status: 'fast-forward', commit: remoteHead, transferred }
        }
        return { ok: false, status: 'raced', transferred }
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
      // the merge commit is orphaned if the CAS loses; report raced, not merged
      if (this.moveRef(name, localHead, commitHash, 'pull', m.message, m.time)) {
        return { ok: true, status: 'merged', commit: commitHash, transferred }
      }
      return { ok: false, status: 'raced', transferred }
    } finally {
      // the ref has moved (or not); the fetched chunks are now reachable or garbage,
      // so they no longer need the pending-root protection
      this.releasePending(fetched)
    }
  }

  // ----- live drafts: realtime editing between commits ------------------------
  //
  // A draft is this same branch with a second pointer, `pending`, naming a chain of
  // immutable operation SEGMENTS in the object store (see live-drafts.md). Editing
  // appends coalesced operations to that chain in realtime; the branch head only moves
  // when the draft is published (settled) into one commit. Reads fold `pending` over
  // the committed head, so an author sees their edits immediately without a commit per
  // keystroke. This is what a guide editor rides: type -> append segment -> read live
  // -> publish -> one commit.

  // The current `pending` segment hash for a branch, or undefined when it has no live
  // draft.
  draftPending(branch: string): string | undefined {
    return this.refs.get(draftRefName(branch))
  }

  // The segments of a branch's pending chain, oldest first.
  private draftSegments(branch: string): Array<Segment> {
    const segments: Array<Segment> = []
    let hash = this.draftPending(branch)
    const seen = new Set<string>()
    while (hash !== undefined && !seen.has(hash)) {
      seen.add(hash)
      const bytes = this.chunks.get(hash)
      if (bytes === undefined) {
        break
      }
      const segment = decodeSegment(bytes)
      segments.push(segment)
      hash = segment.previous
    }
    return segments.reverse()
  }

  // Append a batch of edit operations to a branch's live draft. The batch is coalesced
  // (five keystrokes into one field become one operation), written as one immutable
  // content-addressed segment naming the current tip, and the `pending` pointer is
  // advanced by compare-and-swap. Idempotent under retry: identical operations produce
  // an identical segment hash. Returns the new pending hash.
  appendDraft(branch: string, ops: Array<Op>): { pending: string } {
    if (ops.length === 0) {
      const current = this.draftPending(branch)
      if (current !== undefined) {
        return { pending: current }
      }
    }
    const name = draftRefName(branch)
    for (let attempt = 0; attempt < MAX_CAS_RETRIES; attempt++) {
      const current = this.refs.get(name)
      // coalescing runs WITHIN a segment only, never back across the immutable chain
      const segment: Segment = { previous: current, ops: coalesce(ops) }
      const hash = this.chunks.put(encodeSegment(segment))
      if (hash === current) {
        return { pending: hash } // no-op append (empty coalesce over same tip)
      }
      if (this.refs.compareAndSwap(name, current, hash)) {
        return { pending: hash }
      }
    }
    throw new Error(`could not append draft segment on ${branch} after retries`)
  }

  // The dataset a branch actually shows an editor: the committed head with the pending
  // operations folded on top. Cost is proportional to the pending operations, not the
  // repository.
  draftDataset(branch: string): Dataset {
    return materialize({
      committed: this.checkoutBranch(branch),
      segments: this.draftSegments(branch),
    })
  }

  // Publish (settle) a branch's live draft: fold the pending operations onto the
  // committed head, write ONE commit for the whole burst, advance the head, and clear
  // `pending`. Reuses the full commit path — validation, sealed-field routing, and the
  // three-way-merge-on-race retry — so a publish that races another writer merges
  // instead of failing. A publish with nothing pending is a no-op success.
  publishDraft(branch: string, meta: CommitMeta): CommitResult {
    const pending = this.draftPending(branch)
    if (pending === undefined) {
      const head = this.head(branch)
      if (head === undefined) {
        return { ok: false, diagnostics: [] }
      }
      return { ok: true, commit: head, diagnostics: [] }
    }
    const result = this.commit(branch, meta, this.draftDataset(branch))
    if (result.ok) {
      // clear the pending pointer, but only if no new edits arrived while we settled
      // (which would have advanced it): those stay pending for the next publish, so a
      // concurrent edit is never dropped
      if (this.refs.get(draftRefName(branch)) === pending) {
        this.refs.delete(draftRefName(branch))
      }
    }
    return result
  }

  // Discard a branch's live draft without committing it: drop the pending pointer so
  // the segments become unreachable and a later gc reclaims them.
  discardDraft(branch: string): void {
    const name = draftRefName(branch)
    if (this.refs.get(name) !== undefined) {
      this.refs.delete(name)
    }
  }

  // Every segment hash reachable through a live-draft pending chain. These are held out
  // of gc's reach (segments are loose objects, never referenced by a commit) so an
  // in-flight draft is not swept, matching the "branch.pending is a gc root" rule.
  private draftSegmentHashes(): Set<string> {
    const hashes = new Set<string>()
    for (const ref of this.refs.list()) {
      if (!ref.startsWith(DRAFT_REF_PREFIX)) {
        continue
      }
      let hash: string | undefined = this.refs.get(ref)
      while (hash !== undefined && !hashes.has(hash)) {
        hashes.add(hash)
        const bytes = this.chunks.get(hash)
        if (bytes === undefined) {
          break
        }
        hash = decodeSegment(bytes).previous
      }
    }
    return hashes
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
  // The commits `to` includes that `from` does not — the set folded into a batched
  // projection advance from `from` to `to`. A projection records ALL of these as
  // applied, so a read-your-writes query for any intermediate commit sees its effects
  // as present rather than reporting "behind".
  // Whether a commit belongs to THIS repository: reachable from one of its branch
  // heads or tags. The chunk store may be shared across repositories (a flat
  // content-addressed namespace), so "the commit exists in the store" does NOT mean
  // "this repository may serve it" — a caller who learns another repository's commit
  // hash could otherwise read it through a repository they can see. Reads that accept a
  // client-supplied commit gate on this, not on mere presence.
  containsCommit(commit: string): boolean {
    return this.reachableCommits([
      ...this.branchHeads(),
      ...this.tagTargets(),
    ]).has(commit)
  }

  // `from` undefined means "everything reachable from `to`", which is the fresh-projection
  // case. Symmetrical with `commitChanges`, which treats an undefined `from` as a diff from
  // empty. The two are always called as a pair, so they have to agree on what undefined
  // means or a fresh projection records a different set than it applied.
  //
  // Walks ancestors rather than first parents, so a merge's second parent is covered too.
  // `log` follows first parents only and would silently omit them.
  commitsBetween(from: string | undefined, to: string): Array<string> {
    if (from === undefined) {
      return [...this.ancestors(to)]
    }

    const fromAncestors = this.ancestors(from)
    return [...this.ancestors(to)].filter(c => !fromAncestors.has(c))
  }

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

  // The garbage-collection roots: every branch head and every tag, plus the recent
  // reflog targets, so a tagged release is never collected even after its branch moves
  // on, AND a head that a reset / bad rebase / erasure moved off of stays recoverable
  // via the reflog (which is exactly what resetBranch reads to recover). Only the most
  // recent REFLOG_ROOT_LIMIT entries per ref are rooted, so genuinely old history is
  // still reclaimable — the reflog is a bounded recovery window, not a retention leak.
  // Erasure clears the reflog for the refs it rewrites, so erased content is not kept
  // alive here.
  private retainedRoots(): Array<string> {
    const roots = new Set<string>([...this.branchHeads(), ...this.tagTargets()])
    const reflog = this.opts.reflog
    if (reflog !== undefined) {
      const refs = [
        ...this.branches().map(refName),
        ...this.tags().map(tagRefName),
      ]
      for (const ref of refs) {
        for (const entry of reflog.entries(ref).slice(0, REFLOG_ROOT_LIMIT)) {
          roots.add(entry.to)
          if (entry.from !== undefined) {
            roots.add(entry.from)
          }
        }
      }
    }
    return [...roots]
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
  // Reclaim chunks not reachable from any retained commit, PLUS any chunk registered
  // as pending by an in-flight fetch in this process, so a garbage collection on a
  // timer cannot race a sync and delete just-fetched-but-not-yet-referenced chunks.
  //
  // This guards the single-process case (a worker that syncs and GCs concurrently).
  // A GC in a DIFFERENT process sharing the same store is not covered by an in-memory
  // pending set: that needs a store-level write-time grace window (keep chunks younger
  // than a grace interval), the mechanism `code/gc/refcount.ts` describes and which a
  // timestamped backend would supply. Tracked as remaining hardening.
  gc(opts: { roots?: Array<string> } = {}): GcReport {
    if (!isPrunable(this.chunks)) {
      throw new Error('chunk store does not support garbage collection (not prunable)')
    }
    const reachable = this.reachableChunkHashes(opts.roots)
    for (const hash of this.pendingChunks) {
      reachable.add(hash)
    }
    // live-draft segments are loose objects never referenced by a commit, so they are
    // rooted explicitly here (branch.pending is a gc root) or an in-flight draft would
    // be swept out from under its editor
    for (const hash of this.draftSegmentHashes()) {
      reachable.add(hash)
    }
    return sweep(this.chunks, reachable)
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
      // roll back every ref already repointed, so a raced erasure leaves the repo
      // EXACTLY as it was (all-or-nothing) — the docstring's "deleted nothing"
      // guarantee was false before, since earlier refs stayed on rewritten history
      // while a later one raced, splitting the repo across erased/unerased heads.
      for (const m of moved) {
        this.moveRef(m.branch, m.to, m.from, 'erase-rollback', 'erase aborted', 0)
      }
      throw new ConcurrentErasureError(raced)
    }

    // The erasure succeeded. Clear the reflog line for each rewritten ref: its old
    // entries name the ORIGINAL commits that still contain the erased content, and
    // those hashes are GC roots (see retainedRoots), so leaving them would keep the
    // erased content alive and recoverable — the opposite of an erasure.
    for (const m of moved) {
      this.opts.reflog?.clear(m.branch)
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
