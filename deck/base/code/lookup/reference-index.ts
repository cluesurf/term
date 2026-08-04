import type { Mark, RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

// A maintained reverse-reference index: for any mark, the marks that reference it, in
// O(referrers) rather than a full-dataset scan. Identity operations (merge, split,
// referential removal) need this at scale, where scanning every record per removal is
// the dominant cost. It is maintained by re-indexing a record whenever it changes.
//
// See note/library/base/design/identity-lifecycle.md.

function collectTargets(value: Value, into: Set<Mark>): void {
  if (value.kind === 'ref') {
    into.add(value.target)
  } else if (value.kind === 'collection') {
    for (const it of value.items) {
      collectTargets(it.value, into)
    }
  } else if (value.kind === 'record') {
    for (const v of value.record.fields.values()) {
      collectTargets(v, into)
    }
  }
}

function targetsOf(node: RecordNode): Set<Mark> {
  const out = new Set<Mark>()
  for (const v of node.fields.values()) {
    collectTargets(v, out)
  }
  return out
}

export class ReferenceIndex {
  // owner -> the marks it references
  private forward = new Map<Mark, Set<Mark>>()
  // target -> the marks that reference it
  private reverse = new Map<Mark, Set<Mark>>()

  static fromDataset(dataset: Dataset): ReferenceIndex {
    const idx = new ReferenceIndex()
    for (const [mark, node] of dataset) {
      idx.reindex(mark, node)
    }
    return idx
  }

  // Re-index one record given its new state, or remove it from the index when the
  // node is undefined (the record was removed).
  reindex(mark: Mark, node: RecordNode | undefined): void {
    const prev = this.forward.get(mark)
    if (prev !== undefined) {
      for (const target of prev) {
        this.reverse.get(target)?.delete(mark)
      }
      this.forward.delete(mark)
    }
    if (node === undefined) {
      return
    }
    const targets = targetsOf(node)
    if (targets.size === 0) {
      return
    }
    this.forward.set(mark, targets)
    for (const target of targets) {
      let set = this.reverse.get(target)
      if (set === undefined) {
        set = new Set()
        this.reverse.set(target, set)
      }
      set.add(mark)
    }
  }

  // The marks that reference the given mark.
  referrers(mark: Mark): Array<Mark> {
    const set = this.reverse.get(mark)
    return set === undefined ? [] : [...set]
  }
}
