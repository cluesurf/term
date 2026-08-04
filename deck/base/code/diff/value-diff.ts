import type { Value } from '@/base/type'
import { valueEqual } from '@/base/equal'
import { diffText, type Granularity, type Hunk } from '@/text/diff'

// Leaf-level diff of two field values in a `.tree` record. The semantic diff (see
// ./diff) records which field changed and its whole before and after value, matched by
// mark, not by text line. This turns one such change into the right kind of intra-leaf
// diff for display and blame: a text value is diffed at word granularity (finer than a
// line), while a number is an atomic typed value that changed from one to another, not a
// string to pick digits out of, so it is reported as a whole before-and-after. Anything
// else (a reference, boolean, date, blob, collection, or nested record) is atomic too.
//
// This is the display counterpart to the word-level merge in ./../merge, which combines
// disjoint edits to the same text field. Both run on the parsed value at the leaf, never
// on raw `.tree` text.

export type ValueDiff =
  | { kind: 'equal' }
  | { kind: 'text'; hunks: Array<Hunk> }
  | { kind: 'number'; before: string; after: string }
  // the value's type changed (e.g. a number became a string): flagged distinctly, since
  // that is usually a mistake or a migration, not an ordinary edit
  | { kind: 'retype'; from: Value['kind']; to: Value['kind']; before: Value; after: Value }
  | { kind: 'atomic'; before: Value | undefined; after: Value | undefined }

export function diffValues(
  before: Value | undefined,
  after: Value | undefined,
  granularity: Granularity = 'word',
): ValueDiff {
  if (before !== undefined && after !== undefined && valueEqual(before, after)) {
    return { kind: 'equal' }
  }
  // a type change at the leaf: both sides present and non-null but a different kind, for
  // example an integer that became text. Surfaced on its own so an accidental retype is
  // loud in a diff or blame rather than reading as an ordinary value swap. (In a
  // form-declared field the commit is already blocked by validation; this catches the
  // undeclared case and makes intentional migrations explicit.)
  if (
    before !== undefined &&
    after !== undefined &&
    before.kind !== 'null' &&
    after.kind !== 'null' &&
    before.kind !== after.kind
  ) {
    return { kind: 'retype', from: before.kind, to: after.kind, before, after }
  }
  // strings: token-level diff at the leaf, so a one-word edit is a one-word change
  if (before?.kind === 'text' && after?.kind === 'text') {
    return { kind: 'text', hunks: diffText(before.value, after.value, granularity) }
  }
  // numbers are atomic typed values: report the whole change, never diff the digits
  if (before?.kind === 'integer' && after?.kind === 'integer') {
    return { kind: 'number', before: before.value.toString(), after: after.value.toString() }
  }
  if (before?.kind === 'decimal' && after?.kind === 'decimal') {
    return { kind: 'number', before: before.value, after: after.value }
  }
  // a set or clear (one side null), or references, booleans, dates, blobs, collections,
  // and nested records that changed within their kind
  return { kind: 'atomic', before, after }
}
