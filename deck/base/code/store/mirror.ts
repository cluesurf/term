import type { Mark, RecordNode } from '@/base/type'
import type { ChunkStore } from '@/store/chunk-store'
import { diffRoots, readRecord } from '@/store/tree'

// Catch-up for mirrors. A mirror never replays from genesis: it bootstraps from a
// recent snapshot (a root hash) and catches up by diffing its root against the
// target root and fetching only the records that differ. The cost tracks the size
// of the difference, not the number of commits, so a mirror far behind closes the
// gap in one tree diff.
//
// See note/library/base/design/mirroring-and-catch-up.md.

export type CatchUp = {
  // records to upsert (added or changed) in the mirror
  upsert: Array<RecordNode>
  // marks to delete from the mirror
  remove: Array<Mark>
}

export function catchUp(
  fromRoot: string,
  toRoot: string,
  store: ChunkStore,
): CatchUp {
  const changed = diffRoots(fromRoot, toRoot, store)
  const upsert: Array<RecordNode> = []
  const remove: Array<Mark> = []
  for (const mark of changed) {
    const record = readRecord(toRoot, mark, store)
    if (record === undefined) {
      remove.push(mark)
    } else {
      upsert.push(record)
    }
  }
  return { upsert, remove }
}
