import type { RecordNode } from '@/base/type'
import type { Dataset } from '@/diff/change'
import type { Form, RoleBase } from '@/form/form'
import { toCanonValue, canonicalString } from '@/canon/json'
import { fromCanonValue } from '@/canon/json'
import type { Canon } from '@/canon/json'
import {
  offHistoryRef,
  offHistoryId,
  isOffHistoryRef,
  type OffHistoryStore,
} from '@/offhistory/store'

// Sensitivity routing. A form marks a property sensitive with the `seal` constraint
// (`hold('seal')`). A sealed field's value is stored off-history, in a mutable side
// store, and the record keeps only a reference, so the value can be truly deleted
// without touching immutable history. This is the "off-history by default for regulated
// content" answer, driven entirely by the schema.
//
// See note/library/base/design/deletion-and-legal-removal.md.

// The names of a form's properties marked sensitive with `seal`.
export function sealedProperties(form: Form): Array<string> {
  return form.properties
    .filter(p => p.constraints.some(c => c.kind === 'seal'))
    .map(p => p.name)
}

// Move every sealed field's value into the off-history store, replacing it with an
// off-history reference. Idempotent: a field already an off-history reference is left
// alone, so re-running it after a partial write is safe.
export function partitionSensitive(
  dataset: Dataset,
  role: RoleBase,
  offHistory: OffHistoryStore,
): { dataset: Dataset; moved: number } {
  const out: Dataset = new Map()
  let moved = 0
  for (const [mark, node] of dataset) {
    const form = role.forms.get(node.type)
    const sealed = form ? sealedProperties(form) : []
    if (sealed.length === 0) {
      out.set(mark, node)
      continue
    }
    const fields = new Map(node.fields)
    for (const name of sealed) {
      const value = fields.get(name)
      if (value === undefined || isOffHistoryRef(value)) {
        continue
      }
      const id = offHistory.put(canonicalString(toCanonValue(value)))
      fields.set(name, offHistoryRef(id))
      moved++
    }
    out.set(mark, { ...node, fields })
  }
  return { dataset: out, moved }
}

// Resolve a record's sealed off-history references back to their values, for reading. A
// reference whose content was deleted resolves to null, so a redacted sensitive field
// reads as absent rather than dangling.
export function resolveSensitive(
  node: RecordNode,
  role: RoleBase,
  offHistory: OffHistoryStore,
): RecordNode {
  const form = role.forms.get(node.type)
  const sealed = form ? sealedProperties(form) : []
  if (sealed.length === 0) {
    return node
  }
  const fields = new Map(node.fields)
  for (const name of sealed) {
    const value = fields.get(name)
    if (value === undefined || !isOffHistoryRef(value)) {
      continue
    }
    const content = offHistory.get(offHistoryId(value)!)
    fields.set(
      name,
      content === undefined
        ? { kind: 'null' }
        : fromCanonValue(JSON.parse(content) as Canon),
    )
  }
  return { ...node, fields }
}
