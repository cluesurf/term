import { parseCommit } from '@term/base/code/commit/commit'
import { treeNodeRefs } from '@term/base/code/store/tree'
import { chunkKey, R2ChunkStore, type AsyncChunkStore } from '@term/base/code/store/r2-chunk-store'
import type { ObjectStore } from '@term/base/code/store/object-store'
import { sweepObjectStore, type GcReport } from '@term/base/code/gc/gc'

// Thrown when a chunk that the reachability walk followed a reference into cannot be
// read back. Under an eventually-consistent object store (R2), or a transient network
// error, a live chunk can momentarily read as absent. Continuing would omit its whole
// subtree from the reachable set and then sweep those live chunks — unrecoverable data
// loss. So the walk aborts and NOTHING is deleted; the next GC run retries once the
// store is consistent again.
export class GcAbortedError extends Error {
  constructor(hash: string) {
    super(
      `garbage collection aborted: reachable chunk ${hash} is unavailable; ` +
        `deleting nothing to avoid removing live data`,
    )
    this.name = 'GcAbortedError'
  }
}

// Asynchronous garbage collection for an object-store-only deployment (an R2-backed
// store with no local sync mirror to drive the walk). It reads commit and tree chunks
// over the network to compute the reachable set, then sweeps the object store. This is
// the async twin of the synchronous reachability walk in ./gc, kept in its own module
// so the sync path (which the repository sits on) never pulls in the R2 key layout.
//
// See note/library/base/design/storage-backend.md and
// note/library/base/design/deletion-and-legal-removal.md.

// Collect the record and node chunks of a tree, awaiting each read.
async function collectTreeAsync(
  root: string,
  store: AsyncChunkStore,
  into: Set<string>,
): Promise<void> {
  const stack = [root]
  while (stack.length > 0) {
    const hash = stack.pop()!
    if (into.has(hash)) {
      continue
    }
    into.add(hash)
    const bytes = await store.get(hash)
    if (bytes === undefined) {
      // a node we followed a reference into is unreadable: abort, do not prune
      throw new GcAbortedError(hash)
    }
    const { leaf, refs } = treeNodeRefs(bytes)
    if (leaf) {
      for (const record of refs) {
        into.add(record) // terminal record chunk
      }
    } else {
      for (const child of refs) {
        stack.push(child)
      }
    }
  }
}

// Every chunk reachable from the given commits, computed over an async store.
export async function reachableChunksAsync(
  store: AsyncChunkStore,
  commits: Iterable<string>,
): Promise<Set<string>> {
  const reachable = new Set<string>()
  const seen = new Set<string>()
  const stack = [...commits]
  while (stack.length > 0) {
    const hash = stack.pop()!
    if (seen.has(hash)) {
      continue
    }
    seen.add(hash)
    reachable.add(hash)
    const bytes = await store.get(hash)
    if (bytes === undefined) {
      // a commit reachable from a root is unreadable: abort, do not prune
      throw new GcAbortedError(hash)
    }
    const commit = parseCommit(bytes)
    await collectTreeAsync(commit.root, store, reachable)
    if (commit.changes !== undefined) {
      reachable.add(commit.changes)
    }
    for (const parent of commit.parents) {
      stack.push(parent)
    }
  }
  return reachable
}

// Self-contained async garbage collection for an object store: compute the reachable
// set from the given commit roots (branch heads) and sweep everything else.
export async function collectGarbageAsync(
  objects: ObjectStore,
  roots: Array<string>,
): Promise<GcReport> {
  const store = new R2ChunkStore(objects)
  const reachable = await reachableChunksAsync(store, roots)
  const reachableKeys = new Set<string>()
  for (const hash of reachable) {
    reachableKeys.add(chunkKey(hash))
  }
  return sweepObjectStore(objects, reachableKeys)
}
