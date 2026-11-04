import type { Value } from '@cluesurf/save/base/type'
import { valueEqual } from '@cluesurf/save/base/equal'
import { diffText, type Granularity, type Hunk } from '@cluesurf/save/text/diff'

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
  // two collections, paired member by member: by mark when every member on both sides
  // carries one, by position otherwise. A JSON page body is a list of unmarked nodes
  // and pairs by position; a list of records with ids pairs by identity, so a
  // reordering is `moved` rather than a wall of changes.
  | {
      kind: 'collection'
      added: Array<CollectionMember>
      removed: Array<CollectionMember>
      moved: Array<{ mark: string; from: number; to: number }>
      changed: Array<CollectionMember & { diff: ValueDiff }>
    }
  | { kind: 'atomic'; before: Value | undefined; after: Value | undefined }

/** One member of a diffed collection, where it sits, and what identifies it. */
export type CollectionMember = { at: number; mark?: string; value: Value }

function diffCollections(
  before: Extract<Value, { kind: 'collection' }>,
  after: Extract<Value, { kind: 'collection' }>,
  granularity: Granularity,
): ValueDiff {
  const byMark =
    before.items.length > 0 &&
    after.items.length > 0 &&
    before.items.every(item => item.mark !== undefined) &&
    after.items.every(item => item.mark !== undefined)

  const added: Array<CollectionMember> = []
  const removed: Array<CollectionMember> = []
  const moved: Array<{ mark: string; from: number; to: number }> = []
  const changed: Array<CollectionMember & { diff: ValueDiff }> = []

  if (byMark) {
    const was = new Map(before.items.map((item, at) => [item.mark!, { at, item }]))
    const seen = new Set<string>()

    after.items.forEach((item, at) => {
      const mark = item.mark!
      const prior = was.get(mark)
      seen.add(mark)

      if (!prior) {
        added.push({ at, mark, value: item.value })
        return
      }
      if (prior.at !== at) {
        moved.push({ mark, from: prior.at, to: at })
      }
      if (!valueEqual(prior.item.value, item.value)) {
        changed.push({
          at,
          mark,
          value: item.value,
          diff: diffValues(prior.item.value, item.value, granularity),
        })
      }
    })

    before.items.forEach((item, at) => {
      if (!seen.has(item.mark!)) {
        removed.push({ at, mark: item.mark!, value: item.value })
      }
    })
  } else {
    const shared = Math.min(before.items.length, after.items.length)

    for (let at = 0; at < shared; at++) {
      const b = before.items[at]!.value
      const a = after.items[at]!.value
      if (!valueEqual(b, a)) {
        changed.push({ at, value: a, diff: diffValues(b, a, granularity) })
      }
    }
    for (let at = shared; at < after.items.length; at++) {
      added.push({ at, value: after.items[at]!.value })
    }
    for (let at = shared; at < before.items.length; at++) {
      removed.push({ at, value: before.items[at]!.value })
    }
  }

  return { kind: 'collection', added, removed, moved, changed }
}

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
  // collections: member by member, so a one-node edit inside a page body is one change
  // rather than the whole body swapped
  if (before?.kind === 'collection' && after?.kind === 'collection') {
    return diffCollections(before, after, granularity)
  }
  // a set or clear (one side null), or references, booleans, dates, blobs, collections,
  // and nested records that changed within their kind
  return { kind: 'atomic', before, after }
}
