import type {
  CollectionKind,
  Item,
  Mark,
  RecordNode,
  Value,
} from '@/base/type'
import { valueEqual, recordEqual } from '@/base/equal'
import { canonicalizeValue } from '@/canon/canonicalize'
import type { Dataset } from '@/diff/change'
import { merge3Text } from '@/text/merge'
import { applyFieldPolicy, type FieldPolicyResolver } from '@/merge/policy'
import type { MergePolicy } from '@/form/form'

// Three-way semantic merge. Edits to different fields auto-merge; only concurrent
// edits to the same scalar field conflict; collections merge by their declared
// kind (set unions add-wins, log unions, list merges by item mark, map per key).
// A same-field conflict is surfaced, never resolved by silent last-writer-wins.
//
// See note/library/base/05-diff-and-merge.md and
// note/library/base/design/merge-formal-spec.md.

export type Conflict = {
  mark: Mark
  path: string
  base: Value | undefined
  a: Value
  b: Value
}

export type MergeResult = {
  merged: Dataset
  conflicts: Array<Conflict>
}

type FieldResult = {
  present: boolean
  value?: Value
  conflicts: Array<Conflict>
}

function eqOpt(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined && b === undefined) {
    return true
  }
  if (a === undefined || b === undefined) {
    return false
  }
  return valueEqual(a, b)
}

// Identity of a collection item: its mark, or its canonical value for unmarked
// items, or its key inside a map.
function itemId(kind: CollectionKind, it: Item): string {
  if (kind === 'map') {
    return `k:${it.key ?? ''}`
  }
  if (it.mark !== undefined) {
    return `m:${it.mark}`
  }
  return `v:${canonicalizeValue(it.value)}`
}

function indexItems(
  kind: CollectionKind,
  items: Array<Item> | undefined,
): Map<string, Item> {
  const out = new Map<string, Item>()
  if (items) {
    for (const it of items) {
      out.set(itemId(kind, it), it)
    }
  }
  return out
}

// Merge two collections of the same kind against a common base.
function mergeCollection(
  mark: Mark,
  path: string,
  kind: CollectionKind,
  base: Array<Item> | undefined,
  a: Array<Item>,
  b: Array<Item>,
): { value: Value; conflicts: Array<Conflict> } {
  const conflicts: Array<Conflict> = []
  const baseIx = indexItems(kind, base)
  const aIx = indexItems(kind, a)
  const bIx = indexItems(kind, b)
  const ids = new Set<string>([...aIx.keys(), ...bIx.keys()])

  const kept = new Map<string, Item>()
  for (const id of ids) {
    const inBase = baseIx.has(id)
    const inA = aIx.has(id)
    const inB = bIx.has(id)

    if (kind === 'log') {
      // grow-only: every entry on either side survives
      kept.set(id, (aIx.get(id) ?? bIx.get(id))!)
      continue
    }

    // add-wins membership for set, map, and list item presence
    const present =
      (inA && inB) || (inA && !inBase) || (inB && !inBase)
    if (!present) {
      continue
    }

    // if the item value differs between sides, merge it (maps and lists carry
    // values that can themselves change); for a plain set the value is the id
    const itA = aIx.get(id)
    const itB = bIx.get(id)
    if (itA && itB && !valueEqual(itA.value, itB.value)) {
      const itBase = baseIx.get(id)
      const fr = mergeField(mark, `${path}/${id}`, itBase?.value, itA.value, itB.value)
      conflicts.push(...fr.conflicts)
      kept.set(id, { ...itA, value: fr.present ? fr.value! : itA.value })
    } else {
      kept.set(id, (itA ?? itB)!)
    }
  }

  // ordering: sets and logs are ordered canonically at serialization, so any
  // deterministic array is fine; a list keeps a's order then appends b's new items
  let items: Array<Item>
  if (kind === 'list') {
    const ordered: Array<Item> = []
    const seen = new Set<string>()
    for (const it of a) {
      const id = itemId(kind, it)
      if (kept.has(id)) {
        ordered.push(kept.get(id)!)
        seen.add(id)
      }
    }
    for (const it of b) {
      const id = itemId(kind, it)
      if (kept.has(id) && !seen.has(id)) {
        ordered.push(kept.get(id)!)
        seen.add(id)
      }
    }
    items = ordered
  } else {
    items = [...kept.values()]
  }

  return { value: { kind: 'collection', order: kind, items }, conflicts }
}

// Merge one field value three-way.
function mergeField(
  mark: Mark,
  path: string,
  base: Value | undefined,
  a: Value | undefined,
  b: Value | undefined,
  policy?: MergePolicy,
): FieldResult {
  if (eqOpt(a, b)) {
    return present(a)
  }
  if (eqOpt(a, base)) {
    return present(b)
  }
  if (eqOpt(b, base)) {
    return present(a)
  }
  // both changed differently: a declared field policy resolves it deterministically
  if (policy !== undefined && policy !== 'concurrent') {
    const resolved = applyFieldPolicy(policy, base, a, b)
    if (resolved !== undefined) {
      return present(resolved)
    }
  }
  if (
    a !== undefined &&
    b !== undefined &&
    a.kind === 'collection' &&
    b.kind === 'collection' &&
    a.order === b.order
  ) {
    const baseItems =
      base !== undefined && base.kind === 'collection' ? base.items : undefined
    const m = mergeCollection(mark, path, a.order, baseItems, a.items, b.items)
    return { present: true, value: m.value, conflicts: m.conflicts }
  }
  // two edits to the same text field: merge them at word granularity, so changes to
  // disjoint parts of a long string combine instead of conflicting (finer than a line
  // merge). Only a genuine overlap of the same words still conflicts.
  if (
    a !== undefined &&
    b !== undefined &&
    base !== undefined &&
    a.kind === 'text' &&
    b.kind === 'text' &&
    base.kind === 'text'
  ) {
    const m = merge3Text(base.value, a.value, b.value, 'word')
    if (m.clean) {
      return present({ kind: 'text', value: m.text })
    }
  }
  // scalar or incompatible conflict: keep a provisionally, surface it
  return {
    present: a !== undefined,
    value: a,
    conflicts: [{ mark, path, base, a: a!, b: b! }],
  }
}

function present(value: Value | undefined): FieldResult {
  return { present: value !== undefined, value, conflicts: [] }
}

function mergeRecords(
  mark: Mark,
  base: RecordNode | undefined,
  a: RecordNode,
  b: RecordNode,
  resolve?: FieldPolicyResolver,
): { record: RecordNode; conflicts: Array<Conflict> } {
  const conflicts: Array<Conflict> = []
  const fields = new Map<string, Value>()
  const names = new Set<string>([
    ...(base ? base.fields.keys() : []),
    ...a.fields.keys(),
    ...b.fields.keys(),
  ])
  for (const name of names) {
    const fr = mergeField(
      mark,
      name,
      base?.fields.get(name),
      a.fields.get(name),
      b.fields.get(name),
      resolve?.(a.type, name),
    )
    conflicts.push(...fr.conflicts)
    if (fr.present) {
      fields.set(name, fr.value!)
    }
  }
  const record: RecordNode = { mark, type: a.type, fields }
  if (a.label !== undefined) {
    record.label = a.label
  }
  return { record, conflicts }
}

export type MergeOptions = { policy?: FieldPolicyResolver }

export function mergeDataset(
  base: Dataset,
  a: Dataset,
  b: Dataset,
  opts: MergeOptions = {},
): MergeResult {
  const merged: Dataset = new Map()
  const conflicts: Array<Conflict> = []
  const marks = new Set<string>([...base.keys(), ...a.keys(), ...b.keys()])

  for (const mark of marks) {
    const rBase = base.get(mark)
    const rA = a.get(mark)
    const rB = b.get(mark)
    const inBase = rBase !== undefined

    if (rA && rB) {
      const m = mergeRecords(mark, rBase, rA, rB, opts.policy)
      merged.set(mark, m.record)
      conflicts.push(...m.conflicts)
    } else if (rA && !rB) {
      if (inBase && recordEqual(rBase!, rA)) {
        // b removed it and a left it unchanged: honor the removal
      } else if (inBase) {
        // a edited, b removed: remove-edit conflict, keep a provisionally
        merged.set(mark, rA)
        conflicts.push({
          mark,
          path: '',
          base: undefined,
          a: { kind: 'null' },
          b: { kind: 'null' },
        })
      } else {
        // added in a only
        merged.set(mark, rA)
      }
    } else if (rB && !rA) {
      if (inBase && recordEqual(rBase!, rB)) {
        // a removed it, b unchanged: honor removal
      } else if (inBase) {
        merged.set(mark, rB)
        conflicts.push({
          mark,
          path: '',
          base: undefined,
          a: { kind: 'null' },
          b: { kind: 'null' },
        })
      } else {
        merged.set(mark, rB)
      }
    }
    // present in base only (removed on both): drop
  }

  return { merged, conflicts }
}
