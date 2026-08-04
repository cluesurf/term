import { mintMark } from '@term/base/code/base/mark'
import type { RecordNode } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'
import type { RoleBase } from '@term/base/code/form/form'

// Auto-marking. Registering a form under `role base` turns on the rule that every
// instance must carry a mark. Rather than error, the tooling adds a fresh mark to
// any unmarked instance of a base form. This is the point where volatile becomes
// durable.
//
// See note/library/base/06-schema-and-validation.md.

export function autoMark(
  dataset: Dataset,
  role: RoleBase,
): { dataset: Dataset; added: number } {
  const out: Dataset = new Map()
  let added = 0
  for (const record of dataset.values()) {
    if (record.mark === undefined && role.forms.has(record.type)) {
      const marked: RecordNode = {
        type: record.type,
        fields: record.fields,
        mark: mintMark(),
      }
      if (record.label !== undefined) {
        marked.label = record.label
      }
      out.set(marked.mark!, marked)
      added++
    } else if (record.mark !== undefined) {
      out.set(record.mark, record)
    }
    // an unmarked record of a non-base type stays volatile and is dropped from the
    // durable dataset
  }
  return { dataset: out, added }
}
