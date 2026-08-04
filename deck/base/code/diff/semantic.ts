import type { Mark, RecordNode } from '@/base/type'
import type { Dataset } from '@/diff/change'
import { parentOf } from '@/identity/tree'
import { diffValues, type ValueDiff } from '@/diff/value-diff'

// A semantic diff of the record graph. Where the field-level diff (see ./diff) records
// raw field.set and field.remove, this classifies a change the way a person reads it:
// created, deleted, moved (a parent change, identity preserved, never a delete plus an
// add), renamed (a label change), retyped (the record's form changed), redirected (a
// merge into another record), split, and per-field value changes. A move is reported as
// a move because the mark is stable, which is exactly what git cannot do.
//
// See note/library/base/design/collaboration-correctness.md.

export type SemanticChange =
  | { kind: 'created'; mark: Mark; record: RecordNode }
  | { kind: 'deleted'; mark: Mark; record: RecordNode }
  | { kind: 'moved'; mark: Mark; from: Mark | undefined; to: Mark | undefined }
  | { kind: 'renamed'; mark: Mark; from: string | undefined; to: string | undefined }
  | { kind: 'retyped'; mark: Mark; from: string; to: string }
  | { kind: 'redirected'; mark: Mark; to: Mark } // merged into another record
  | { kind: 'split'; mark: Mark } // split into parts
  | { kind: 'field'; mark: Mark; field: string; diff: ValueDiff }

const PARENT = '~parent'
const REDIRECT = '~redirect'
const SPLIT = '~split'

function redirectTarget(node: RecordNode): Mark | undefined {
  const v = node.fields.get(REDIRECT)
  return v !== undefined && v.kind === 'ref' ? v.target : undefined
}

export function diffSemantic(before: Dataset, after: Dataset): Array<SemanticChange> {
  const out: Array<SemanticChange> = []
  const marks = new Set<Mark>([...before.keys(), ...after.keys()])

  for (const mark of [...marks].sort()) {
    const b = before.get(mark)
    const a = after.get(mark)

    if (b === undefined && a !== undefined) {
      out.push({ kind: 'created', mark, record: a })
      continue
    }
    if (b !== undefined && a === undefined) {
      out.push({ kind: 'deleted', mark, record: b })
      continue
    }
    if (b === undefined || a === undefined) {
      continue
    }

    // a record turned into a redirect or split marker: report the identity operation
    const wasRedirect = redirectTarget(b)
    const nowRedirect = redirectTarget(a)
    if (nowRedirect !== undefined && wasRedirect === undefined) {
      out.push({ kind: 'redirected', mark, to: nowRedirect })
      continue
    }
    if (a.fields.has(SPLIT) && !b.fields.has(SPLIT)) {
      out.push({ kind: 'split', mark })
      continue
    }

    if (b.type !== a.type) {
      out.push({ kind: 'retyped', mark, from: b.type, to: a.type })
    }
    if (b.label !== a.label) {
      out.push({ kind: 'renamed', mark, from: b.label, to: a.label })
    }
    const fromParent = parentOf(b)
    const toParent = parentOf(a)
    if (fromParent !== toParent) {
      out.push({ kind: 'moved', mark, from: fromParent, to: toParent })
    }

    // remaining field changes, excluding the parent (reported as a move)
    const fields = new Set<string>([...b.fields.keys(), ...a.fields.keys()])
    for (const field of [...fields].sort()) {
      if (field === PARENT) {
        continue
      }
      const bv = b.fields.get(field)
      const av = a.fields.get(field)
      const vd = diffValues(bv, av)
      if (vd.kind !== 'equal') {
        out.push({ kind: 'field', mark, field, diff: vd })
      }
    }
  }
  return out
}

// A one-line-per-change human summary, newest concepts first. Useful for a history view.
export function summarizeSemantic(changes: Array<SemanticChange>): Array<string> {
  return changes.map(c => {
    switch (c.kind) {
      case 'created':
        return `created ${c.record.type} ${c.mark}`
      case 'deleted':
        return `deleted ${c.record.type} ${c.mark}`
      case 'moved':
        return `moved ${c.mark} from ${c.from ?? 'root'} to ${c.to ?? 'root'}`
      case 'renamed':
        return `renamed ${c.mark} from ${c.from ?? '(none)'} to ${c.to ?? '(none)'}`
      case 'retyped':
        return `retyped ${c.mark} from ${c.from} to ${c.to}`
      case 'redirected':
        return `merged ${c.mark} into ${c.to}`
      case 'split':
        return `split ${c.mark}`
      case 'field':
        return `changed ${c.field} of ${c.mark}`
    }
  })
}
