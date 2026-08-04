import { readCommit } from '@/commit/commit'
import { collectChunkHashes } from '@/store/tree'
import type { ChunkStore, PrunableChunkStore } from '@/store/chunk-store'
import type { ObjectStore } from '@/store/object-store'

// Garbage collection for the chunk store. Every chunk is content-addressed and
// immutable, so a chunk is live exactly when it is reachable from a retained commit:
// the commit object itself, its recorded change set, and its record-tree (all tree
// nodes and record chunks), transitively through parents. Anything not reachable from a
// live root (a branch head, a kept tag) is garbage: an orphaned failed-CAS commit, an
// abandoned branch, or content that a history rewrite made unreachable. Mark and sweep.
//
// See note/library/base/design/deletion-and-legal-removal.md.

// Every chunk reachable from the given commits: the commit objects, their change sets,
// and their whole record-trees, following parents.
export function reachableChunks(
  chunks: ChunkStore,
  commits: Iterable<string>,
): Set<string> {
  const reachable = new Set<string>()
  const seenCommits = new Set<string>()
  const stack = [...commits]
  while (stack.length > 0) {
    const hash = stack.pop()!
    if (seenCommits.has(hash)) {
      continue
    }
    seenCommits.add(hash)
    reachable.add(hash) // the commit object is itself a chunk
    const commit = readCommit(hash, chunks)
    collectChunkHashes(commit.root, chunks, reachable) // tree nodes + record chunks
    if (commit.changes !== undefined) {
      reachable.add(commit.changes)
    }
    for (const parent of commit.parents) {
      stack.push(parent)
    }
  }
  return reachable
}

export type GcReport = {
  // chunks deleted
  removed: number
  // chunks retained (the reachable set size)
  kept: number
  // the hashes that were deleted, for auditing
  removedHashes: Array<string>
}

// Delete every chunk not in the reachable set. Returns what was reclaimed.
export function sweep(
  store: PrunableChunkStore,
  reachable: Set<string>,
): GcReport {
  const removedHashes: Array<string> = []
  for (const hash of store.keys()) {
    if (!reachable.has(hash)) {
      store.delete(hash)
      removedHashes.push(hash)
    }
  }
  return { removed: removedHashes.length, kept: reachable.size, removedHashes }
}

// Sweep an object-store mirror (for example R2) against the set of reachable object
// keys. The caller maps the repository's reachable chunk hashes to object keys with the
// same `chunkKey` the R2 chunk store writes, so gc stays independent of the key layout
// and the mirror is reclaimed without a second reachability walk over the network.
export async function sweepObjectStore(
  objects: ObjectStore,
  reachableKeys: Set<string>,
): Promise<GcReport> {
  const removedHashes: Array<string> = []
  for (const key of await objects.list()) {
    if (!reachableKeys.has(key)) {
      await objects.delete(key)
      removedHashes.push(key)
    }
  }
  return { removed: removedHashes.length, kept: reachableKeys.size, removedHashes }
}

