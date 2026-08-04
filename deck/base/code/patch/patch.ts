import type { RecordNode } from '@/base/type'
import type { Change, Dataset } from '@/diff/change'

// Apply a change set to a dataset, producing a new dataset. Pure: the input is not
// mutated. This is how a commit is projected into any downstream store and how a
// diff is verified to round-trip (apply(diff(a, b)) to a yields b).

function cloneRecord(node: RecordNode): RecordNode {
  const out: RecordNode = {
    type: node.type,
    fields: new Map(node.fields),
  }
  if (node.mark !== undefined) {
    out.mark = node.mark
  }
  if (node.label !== undefined) {
    out.label = node.label
  }
  return out
}

export function applyChanges(
  base: Dataset,
  changes: Array<Change>,
): Dataset {
  const out: Dataset = new Map(base)
  for (const change of changes) {
    switch (change.type) {
      case 'record.add':
        out.set(change.mark, change.value)
        break
      case 'record.remove':
        out.delete(change.mark)
        break
      case 'field.set': {
        const existing = out.get(change.mark)
        if (!existing) {
          throw new Error(`field.set on missing record ${change.mark}`)
        }
        const next = cloneRecord(existing)
        next.fields.set(change.field, change.after)
        out.set(change.mark, next)
        break
      }
      case 'field.remove': {
        const existing = out.get(change.mark)
        if (!existing) {
          throw new Error(`field.remove on missing record ${change.mark}`)
        }
        const next = cloneRecord(existing)
        next.fields.delete(change.field)
        out.set(change.mark, next)
        break
      }
    }
  }
  return out
}
