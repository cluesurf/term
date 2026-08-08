import type { RecordNode } from '@term/base/code/base/type'
import type { Change, Comments, Dataset } from '@term/base/code/diff/change'

// Apply a change set to a dataset, producing a new dataset. Pure: the input is not
// mutated. This is how a commit is projected into any downstream store and how a
// diff is verified to round-trip (apply(diff(a, b)) to a yields b).

function cloneComments(comments: Comments): Comments {
  return new Map([...comments].map(([key, lines]) => [key, [...lines]]))
}

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
  // comments are part of the record's hash; dropping them on a field patch made
  // an incrementally-projected record differ from a full checkout of the same
  // commit even when the commit never touched comments
  if (node.comments !== undefined) {
    out.comments = cloneComments(node.comments)
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
      case 'record.relabel': {
        const existing = out.get(change.mark)
        if (!existing) {
          throw new Error(`record.relabel on missing record ${change.mark}`)
        }
        const next = cloneRecord(existing)
        if (change.after === undefined) {
          delete next.label
        } else {
          next.label = change.after
        }
        out.set(change.mark, next)
        break
      }
      case 'record.retype': {
        const existing = out.get(change.mark)
        if (!existing) {
          throw new Error(`record.retype on missing record ${change.mark}`)
        }
        const next = cloneRecord(existing)
        next.type = change.after
        out.set(change.mark, next)
        break
      }
      case 'record.recomment': {
        const existing = out.get(change.mark)
        if (!existing) {
          throw new Error(`record.recomment on missing record ${change.mark}`)
        }
        const next = cloneRecord(existing)
        if (change.after === undefined || change.after.size === 0) {
          delete next.comments
        } else {
          next.comments = cloneComments(change.after)
        }
        out.set(change.mark, next)
        break
      }
    }
  }
  return out
}
