import type { Mark, RecordNode } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'
import { readCommit } from '@term/base/code/commit/commit'
import { collectChunkHashes, readDataset } from '@term/base/code/store/tree'
import type { ChunkStore } from '@term/base/code/store/chunk-store'
import type { ChunkMessage } from '@term/base/code/sync/chunk-sync'

// Partial replication. Not every replica wants all of history or all of the data. A
// shallow fetch takes a commit's full state without its ancestry (a snapshot: current
// data, no history), and a sparse fetch takes only the records that match a filter (a
// subset: some types or entities, not the whole graph). Both exploit the content-
// addressed model: a snapshot is the chunks under one root, a subset is the records that
// pass a predicate, materialized for a projection. A shallow replica reads the current
// state but cannot walk past its boundary commit, exactly like a git shallow clone.
//
// See note/library/base/design/sync-and-transport.md.

// The chunks of a single commit's state, without its parents (a shallow boundary).
export function shallowChunks(commit: string, chunks: ChunkStore): Set<string> {
  const c = readCommit(commit, chunks)
  const set = new Set<string>([commit])
  collectChunkHashes(c.root, chunks, set)
  if (c.changes !== undefined) {
    set.add(c.changes)
  }
  return set // deliberately no parent commits
}

// Package a shallow snapshot for transfer.
export function packShallow(commit: string, chunks: ChunkStore): Array<ChunkMessage> {
  const out: Array<ChunkMessage> = []
  for (const hash of shallowChunks(commit, chunks)) {
    const bytes = chunks.get(hash)
    if (bytes !== undefined) {
      out.push({ hash, bytes })
    }
  }
  return out
}

// A sparse subset of a commit's records: only those that pass the filter. Materialized
// as a dataset for a projection, rather than as a tree slice, since a filtered set does
// not form a contiguous subtree.
export function sparseRecords(
  commit: string,
  chunks: ChunkStore,
  filter: (record: RecordNode) => boolean,
): Dataset {
  const full = readDataset(readCommit(commit, chunks).root, chunks)
  const out: Dataset = new Map<Mark, RecordNode>()
  for (const [mark, record] of full) {
    if (filter(record)) {
      out.set(mark, record)
    }
  }
  return out
}

// A common sparse filter: records of one of the given types.
export function ofTypes(types: Array<string>): (record: RecordNode) => boolean {
  const set = new Set(types)
  return record => set.has(record.type)
}
