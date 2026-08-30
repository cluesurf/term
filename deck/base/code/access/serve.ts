// Enforcing access at the SERVED boundary.
//
// A served repository is the first time authorisation is not the application's job. Until
// now a `RemoteRepo` forwarded straight to the stores, so any peer that could reach it could
// read anything and move any ref. `AccessPolicy` existed and was tested, and nothing on the
// wire consulted it.
//
// THE PART THAT IS EASY TO GET WRONG: gating `getChunk` on nothing is not merely permissive,
// it is a full read bypass, because a chunk is addressed by its hash and **hashes leak by
// design**. Every commit names its parents and its root, every log line carries a commit
// hash, every citeable release publishes one. So an unguarded `getChunk` means anyone who has
// ever seen a hash can read that content forever, regardless of what the policy says about
// the branch it sits under.
//
// A guard therefore cannot answer per chunk in isolation. It has to answer "is this chunk
// reachable from a ref this user may read", which is why this wraps a repository rather than
// only a store.
//
// The other half is refs. A user who cannot read a branch must not learn it EXISTS, so
// `listRefs` filters rather than denying, and `getRef` answers undefined rather than
// throwing: a refusal that distinguishes "no such branch" from "not for you" is an
// enumeration oracle.
//
// See note/library/base/design/access-control-and-authorship.md and
// note/library/base/project/base-hosted.md.

import type { RemoteRepo } from '@term/base/code/transport/session'
import type { AccessPolicy } from '@term/base/code/access/policy'
import type { ChunkStore } from '@term/base/code/store/chunk-store'
import { reachableChunks } from '@term/base/code/gc/gc'

/** Refused because the policy says so. Never carries what was refused. */
export class Denied extends Error {
  constructor(action: string) {
    // Deliberately says nothing about the resource. A message naming the branch or the hash
    // tells an unauthorised caller that it exists, which is the thing being withheld.
    super(`not permitted: ${action}`)
    this.name = 'Denied'
  }
}

function branchOf(ref: string): string | undefined {
  return ref.startsWith('branch/') ? ref.slice('branch/'.length) : undefined
}

/**
 * The resource a ref sits under, for the policy.
 *
 * A branch ref maps to `branch:<name>` so a per-branch grant works. Anything else (a tag, the
 * format ref, a draft) maps to `repo`, so it needs a repository-wide grant rather than being
 * silently ungoverned. Defaulting the unknown case to `repo` rather than to permitted is what
 * keeps a new ref namespace from arriving unguarded.
 */
function resourceOf(ref: string): string {
  const branch = branchOf(ref)

  return branch === undefined ? 'repo' : `branch:${branch}`
}

/**
 * Wrap a remote so every call is checked against a policy for one user.
 *
 * `reach` supplies the chunks reachable from the refs this user may read. It is a function
 * rather than a set so it is recomputed per call: caching it would let a chunk stay readable
 * after the grant that reached it was revoked, which is the kind of staleness that turns a
 * revocation into a formality.
 */
export function guard(input: {
  inner: RemoteRepo
  policy: AccessPolicy
  user: string
  // every ref name the underlying repository holds, so filtering can be done without
  // asking the inner remote for things this user may not see
  refs: () => string[]
  // the chunk store, to compute reachability from the refs this user may read
  chunks: ChunkStore
  // resolve a ref to its commit, for the reachability walk
  head: (ref: string) => string | undefined
}): RemoteRepo {
  const mayRead = (ref: string): boolean =>
    input.policy.can(input.user, 'read', resourceOf(ref))

  /** Chunks reachable from every ref this user may read, recomputed per call. */
  const visible = (): Set<string> => {
    const roots: string[] = []

    for (const ref of input.refs()) {
      if (!mayRead(ref)) {
        continue
      }

      const at = input.head(ref)

      if (at !== undefined) {
        roots.push(at)
      }
    }

    return reachableChunks(input.chunks, roots)
  }

  return {
    async hasChunk(hash: string): Promise<boolean> {
      // Answers false rather than throwing for a chunk this user cannot reach. `has` is a
      // probe, and a probe that distinguishes "absent" from "forbidden" is an oracle for
      // whether a hash exists, which is exactly what a guessing attacker wants.
      return visible().has(hash) && input.inner.hasChunk(hash)
    },

    async getChunk(hash: string): Promise<string | undefined> {
      if (!visible().has(hash)) {
        return undefined
      }

      return input.inner.getChunk(hash)
    },

    async putChunk(bytes: string): Promise<string> {
      // Writing a chunk is not yet a change to anything: it becomes real when a ref moves,
      // and that is where `commit` is required. But an unauthenticated peer filling the store
      // is a denial-of-service rather than a disclosure, so `propose` is the floor.
      if (!input.policy.can(input.user, 'propose', 'repo')) {
        throw new Denied('write a chunk')
      }

      return input.inner.putChunk(bytes)
    },

    async getRef(name: string): Promise<string | undefined> {
      // undefined rather than a refusal: distinguishing "no such branch" from "not for you"
      // tells an unauthorised caller which branches exist
      if (!mayRead(name)) {
        return undefined
      }

      return input.inner.getRef(name)
    },

    async setRef(
      name: string,
      expected: string | undefined,
      next: string,
    ): Promise<boolean> {
      if (!input.policy.can(input.user, 'commit', resourceOf(name))) {
        throw new Denied('move a ref')
      }

      return input.inner.setRef(name, expected, next)
    },

    async listRefs(): Promise<string[]> {
      // Filtered rather than refused, so a user with one branch sees one branch rather than
      // learning how many exist.
      return (await input.inner.listRefs()).filter(mayRead)
    },
  }
}
