import type { Mark, RecordNode, Value } from '@/base/type'

// The typed, field-level change set. A commit is a set of these, keyed by mark, so
// history records exactly what changed rather than which lines moved. Recording
// `before` alongside `after` makes changes auditable, reversible, and the input to
// three-way merge and incremental projection.
//
// See note/library/base/04-commit-and-patch.md.

export type Change =
  | { type: 'record.add'; mark: Mark; value: RecordNode }
  | { type: 'record.remove'; mark: Mark; before: RecordNode }
  | {
      type: 'field.set'
      mark: Mark
      field: string
      before: Value | undefined
      after: Value
    }
  | {
      type: 'field.remove'
      mark: Mark
      field: string
      before: Value
    }

// A dataset is a set of marked records, addressed by mark. This is the unit that
// is diffed, merged, patched, and projected.
export type Dataset = Map<Mark, RecordNode>

export function emptyDataset(): Dataset {
  return new Map()
}

export function datasetOf(records: Array<RecordNode>): Dataset {
  const out: Dataset = new Map()
  for (const r of records) {
    if (r.mark === undefined) {
      throw new Error(`record of type ${r.type} has no mark, cannot enter a dataset`)
    }
    out.set(r.mark, r)
  }
  return out
}
