import type { Change } from '@term/base/code/diff/change'

// A mark-to-commits index: which commits touched a given record. base already stores
// each commit's field-level change set, so this is built by reading those sets rather
// than diffing trees, which is what makes per-record history cheap. Git has no
// equivalent (it must diff trees to answer "history of this path"); because base records
// exactly what changed, the index falls out of the data it already keeps.
//
// See note/library/base/design/history-operations.md.

export class MarkIndex {
  // mark -> commit hashes that touched it, in the order added (newest first if built
  // from a newest-first log)
  private index = new Map<string, Array<string>>()

  add(mark: string, commit: string): void {
    let list = this.index.get(mark)
    if (list === undefined) {
      list = []
      this.index.set(mark, list)
    }
    if (list[list.length - 1] !== commit) {
      list.push(commit)
    }
  }

  // The commits that touched a mark, in index order.
  commitsFor(mark: string): Array<string> {
    return this.index.get(mark) ?? []
  }

  // All marks the index knows about.
  marks(): Array<string> {
    return [...this.index.keys()]
  }
}

// The marks a change set touches.
export function marksTouched(changes: Array<Change>): Set<string> {
  const out = new Set<string>()
  for (const c of changes) {
    out.add(c.mark)
  }
  return out
}
