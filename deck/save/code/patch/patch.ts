import type { RecordNode } from '@cluesurf/save/base/type'
import type { Change, Comments, Dataset } from '@cluesurf/save/diff/change'

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
      case 'record.add': {
        // A DATASET ENTRY CARRIES ITS KEY AS ITS MARK. The change names the mark and the
        // node is the record, and a caller building the node from a database row can
        // leave the node's own `mark` out, which is what mesh's `addRecord` did. The
        // node then sat in the dataset under its mark with no mark on it, and the role
        // refused it with `instance of a base form must have a mark`, on every page
        // commit, the first time a repository with registered forms was written to. The
        // invariant is this module's, so it is held here rather than at every caller.
        out.set(
          change.mark,
          change.value.mark === change.mark
            ? change.value
            : { ...cloneRecord(change.value), mark: change.mark },
        )
        break
      }
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
