import type { RecordNode } from '@term/base/code/base/type'
import { valueEqual } from '@term/base/code/base/equal'
import type { Change, Comments, Dataset } from '@term/base/code/diff/change'

// Two comment maps are equal when they hold the same lines under the same keys.
// Order of lines under a key is meaningful (it is how they render), so it is
// compared positionally; key order is not.
export function commentsEqual(
  a: Comments | undefined,
  b: Comments | undefined,
): boolean {
  const aSize = a?.size ?? 0
  const bSize = b?.size ?? 0
  if (aSize !== bSize) {
    return false
  }
  if (a === undefined || b === undefined) {
    return aSize === 0
  }
  for (const [key, aLines] of a) {
    const bLines = b.get(key)
    if (bLines === undefined || bLines.length !== aLines.length) {
      return false
    }
    for (let i = 0; i < aLines.length; i++) {
      if (aLines[i] !== bLines[i]) {
        return false
      }
    }
  }
  return true
}

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
  // header (type, label, comments) is hashed content, so a change to it is a real
  // change; emit it after the fields in a deterministic order. Without these a
  // pure rename / retype / comment edit diffs to nothing and cannot be committed.
  if (base.type !== next.type) {
    changes.push({ type: 'record.retype', mark, before: base.type, after: next.type })
  }
  if (base.label !== next.label) {
    changes.push({
      type: 'record.relabel',
      mark,
      before: base.label,
      after: next.label,
    })
  }
  if (!commentsEqual(base.comments, next.comments)) {
    changes.push({
      type: 'record.recomment',
      mark,
      before: base.comments,
      after: next.comments,
    })
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
