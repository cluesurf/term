import type {
  CollectionKind,
  Item,
  Mark,
  RecordNode,
  Value,
} from '@term/base/code/base/type'
import { valueEqual, recordEqual } from '@term/base/code/base/equal'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'
import type { Comments, Dataset } from '@term/base/code/diff/change'
import { commentsEqual } from '@term/base/code/diff/diff'
import { merge3Text } from '@term/base/code/text/merge'
import { applyFieldPolicy, type FieldPolicyResolver } from '@term/base/code/merge/policy'
import type { MergePolicy } from '@term/base/code/form/form'

// Three-way semantic merge. Edits to different fields auto-merge; only concurrent
// edits to the same scalar field conflict; collections merge by their declared
// kind (set unions add-wins, log unions, list merges by item mark, map per key).
// A same-field conflict is surfaced, never resolved by silent last-writer-wins.
//
// See note/library/base/05-diff-and-merge.md and
// note/library/base/design/merge-formal-spec.md.

// What a conflict is about. 'field' is the default (a field value). The header
// scopes carry the label / type text (or a null value when absent) as `a`/`b`.
// 'record' is a whole-record delete-vs-edit: the surviving edited record travels
// as a { kind: 'record' } value on the side that kept it, and { kind: 'null' } on
// the side that deleted it, so a resolver can restore or delete deliberately.
export type ConflictScope = 'field' | 'label' | 'type' | 'record'

export type Conflict = {
  mark: Mark
  path: string
  base: Value | undefined
  a: Value
  b: Value
  scope?: ConflictScope
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

    const itA = aIx.get(id)
    const itB = bIx.get(id)

    // A base item that one side edited and the other removed is an edit-vs-delete
    // conflict, exactly as at the record level — the add-wins membership formula
    // alone would silently drop it (present=false) and lose the surviving edit.
    // Keep the edited value provisionally and surface the conflict.
    if (inBase && inA !== inB) {
      const itBase = baseIx.get(id)
      const survivor = itA ?? itB
      if (
        survivor &&
        itBase &&
        !valueEqual(survivor.value, itBase.value)
      ) {
        kept.set(id, survivor)
        conflicts.push({
          mark,
          path: `${path}/${id}`,
          base: itBase.value,
          a: itA ? itA.value : { kind: 'null' },
          b: itB ? itB.value : { kind: 'null' },
        })
        continue
      }
    }

    // add-wins membership for set, map, and list item presence
    const present =
      (inA && inB) || (inA && !inBase) || (inB && !inBase)
    if (!present) {
      continue
    }

    // if the item value differs between sides, merge it (maps and lists carry
    // values that can themselves change); for a plain set the value is the id
    if (itA && itB && !valueEqual(itA.value, itB.value)) {
      const itBase = baseIx.get(id)
      const fr = mergeField(mark, `${path}/${id}`, itBase?.value, itA.value, itB.value)
      conflicts.push(...fr.conflicts)
      kept.set(id, { ...itA, value: fr.present ? fr.value! : itA.value })
    } else {
      kept.set(id, (itA ?? itB)!)
    }
  }

  // Ordering. Sets and maps are re-sorted canonically at serialization, so their
  // array order here does not affect the hash. But LIST and LOG order IS preserved
  // canonically, so the merged order must be a deterministic function of the inputs
  // or two replicas merging in opposite orders diverge.
  let items: Array<Item>
  if (kind === 'log') {
    // grow-only log: keep the base entries in their original (chronological) order,
    // then append the entries new to either side in a side-independent order (by
    // item id), so merge(base,a,b) and merge(base,b,a) produce identical bytes and
    // the log actually converges.
    const ordered: Array<Item> = []
    const seen = new Set<string>()
    if (base) {
      for (const it of base) {
        const id = itemId(kind, it)
        if (kept.has(id)) {
          ordered.push(kept.get(id)!)
          seen.add(id)
        }
      }
    }
    for (const id of [...kept.keys()].filter(id => !seen.has(id)).sort()) {
      ordered.push(kept.get(id)!)
    }
    items = ordered
  } else if (kind === 'list') {
    // A list's order is authored, so the merge is intentionally NOT commutative:
    // a's order is primary, then b's new items append. Two replicas that merge in
    // opposite orders can differ here — this is the documented cost of a merge over
    // an ordered sequence without a sequence CRDT (see live-drafts.md).
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

// A header value as a merge Value, so a header conflict rides the same Conflict
// shape as a field: text when present, null when absent.
function headerValue(text: string | undefined): Value {
  return text === undefined ? { kind: 'null' } : { kind: 'text', value: text }
}

// Three-way merge one optional header string (label). Returns the merged value
// and, when both sides changed it differently, a conflict under the given scope.
function mergeHeaderText(
  mark: Mark,
  scope: 'label' | 'type',
  base: string | undefined,
  a: string | undefined,
  b: string | undefined,
): { value: string | undefined; conflict?: Conflict } {
  if (a === b) {
    return { value: a }
  }
  if (a === base) {
    return { value: b }
  }
  if (b === base) {
    return { value: a }
  }
  // both changed the header differently: keep a provisionally, surface it — a
  // concurrent rename or retype is a real conflict, not a silent last-writer-wins
  return {
    value: a,
    conflict: {
      mark,
      path: `@${scope}`,
      scope,
      base: headerValue(base),
      a: headerValue(a),
      b: headerValue(b),
    },
  }
}

// Three-way merge the comment map as a unit. Comments are authored annotations,
// not queryable data, so a genuine concurrent divergence keeps `a` rather than
// surfacing a field-style conflict (there is nothing to resolve through the field
// machinery); the point of the three-way is to PRESERVE comments and to keep a
// one-sided edit, which the old code dropped entirely.
function mergeComments(
  base: Comments | undefined,
  a: Comments | undefined,
  b: Comments | undefined,
): Comments | undefined {
  if (commentsEqual(a, b)) {
    return a
  }
  if (commentsEqual(a, base)) {
    return b
  }
  if (commentsEqual(b, base)) {
    return a
  }
  return a
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

  // header (type, label, comments) is hashed content and merges three-way like a
  // field, so a one-sided rename / retype / comment edit is kept and a concurrent
  // divergent one conflicts, instead of the old behaviour that always took a's
  // and silently dropped b's header and every comment.
  const typeMerge = mergeHeaderText(mark, 'type', base?.type, a.type, b.type)
  if (typeMerge.conflict) {
    conflicts.push(typeMerge.conflict)
  }
  const labelMerge = mergeHeaderText(mark, 'label', base?.label, a.label, b.label)
  if (labelMerge.conflict) {
    conflicts.push(labelMerge.conflict)
  }
  const comments = mergeComments(base?.comments, a.comments, b.comments)

  const record: RecordNode = {
    mark,
    // type is required; a divergent retype keeps a's value provisionally
    type: typeMerge.value ?? a.type,
    fields,
  }
  if (labelMerge.value !== undefined) {
    record.label = labelMerge.value
  }
  if (comments !== undefined && comments.size > 0) {
    record.comments = comments
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
        // a edited, b removed: record delete-vs-edit conflict. Keep a's edited
        // record provisionally and carry both dispositions so a resolver can
        // restore (a) or delete (b) — the old conflict used a=b={null}, so the
        // resolver could neither tell the sides apart nor actually delete.
        merged.set(mark, rA)
        conflicts.push({
          mark,
          path: '',
          scope: 'record',
          base: undefined,
          a: { kind: 'record', record: rA },
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
        // b edited, a removed: symmetric record delete-vs-edit conflict
        merged.set(mark, rB)
        conflicts.push({
          mark,
          path: '',
          scope: 'record',
          base: undefined,
          a: { kind: 'null' },
          b: { kind: 'record', record: rB },
        })
      } else {
        merged.set(mark, rB)
      }
    }
    // present in base only (removed on both): drop
  }

  return { merged, conflicts }
}
