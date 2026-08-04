import type { RecordNode } from '@term/base/code/base/type'
import { valueEqual } from '@term/base/code/base/equal'
import type { Change, Dataset } from '@term/base/code/diff/change'

// Semantic diff. Given two datasets, produce the field-level change set that turns
// one into the other, matched by mark, not by position or line. A record moved,
// reordered, or reformatted with no field change produces no diff.
//
// See note/library/base/05-diff-and-merge.md.

// Diff two records of the same mark into field-level changes.
export function diffRecord(
  mark: string,
  base: RecordNode,
  next: RecordNode,
): Array<Change> {
  const changes: Array<Change> = []
  const names = new Set<string>([...base.fields.keys(), ...next.fields.keys()])
  for (const field of [...names].sort()) {
    const before = base.fields.get(field)
    const after = next.fields.get(field)
    if (after === undefined && before !== undefined) {
      changes.push({ type: 'field.remove', mark, field, before })
    } else if (after !== undefined && before === undefined) {
      changes.push({ type: 'field.set', mark, field, before: undefined, after })
    } else if (
      after !== undefined &&
      before !== undefined &&
      !valueEqual(before, after)
    ) {
      changes.push({ type: 'field.set', mark, field, before, after })
    }
  }
  return changes
}

// Diff two datasets into a change set: records added, removed, and, for records
// present in both, their field-level changes.
export function diffDataset(base: Dataset, next: Dataset): Array<Change> {
  const changes: Array<Change> = []
  const marks = new Set<string>([...base.keys(), ...next.keys()])
  for (const mark of [...marks].sort()) {
    const b = base.get(mark)
    const n = next.get(mark)
    if (b === undefined && n !== undefined) {
      changes.push({ type: 'record.add', mark, value: n })
    } else if (b !== undefined && n === undefined) {
      changes.push({ type: 'record.remove', mark, before: b })
    } else if (b !== undefined && n !== undefined) {
      changes.push(...diffRecord(mark, b, n))
    }
  }
  return changes
}
