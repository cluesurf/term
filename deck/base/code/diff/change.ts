import type { Mark, RecordNode, Value } from '@term/base/code/base/type'

// The typed, field-level change set. A commit is a set of these, keyed by mark, so
// history records exactly what changed rather than which lines moved. Recording
// `before` alongside `after` makes changes auditable, reversible, and the input to
// three-way merge and incremental projection.
//
// See note/library/base/04-commit-and-patch.md.

// Authored comments on a record, keyed by the field they sit above (the empty
// key holds the record-level comments). Part of the record's hash.
export type Comments = Map<string, Array<string>>

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
  // The record header (label, type, comments) is content and part of the hash,
  // so a change to any of it must be representable, or a pure rename / retype /
  // comment edit produces an empty diff and cannot be committed, and an
  // incremental projection drifts from a full checkout. Each header field is its
  // own change so blame reads "relabeled" / "retyped" rather than a blob.
  | {
      type: 'record.relabel'
      mark: Mark
      before: string | undefined
      after: string | undefined
    }
  | { type: 'record.retype'; mark: Mark; before: string; after: string }
  | {
      type: 'record.recomment'
      mark: Mark
      before: Comments | undefined
      after: Comments | undefined
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
