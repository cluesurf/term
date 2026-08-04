import type { Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'
import { mergeDataset, type Conflict } from '@term/base/code/merge/merge'
import { applyChanges } from '@term/base/code/patch/patch'

// A merge session holds a half-merged state so conflicts can be resolved deliberately
// and then committed, instead of the merge either fully succeeding or being rejected.
// The three-way merge auto-resolves everything it can and leaves only genuine same-field
// conflicts; the session lets a person pick a side or a custom value per conflict, tracks
// what is still unresolved, and produces the final dataset. This is the collaborative
// editing workflow (git's conflicted index), at the field level.
//
// See note/library/base/design/merge-formal-spec.md.

// How a conflict is resolved.
export type Resolution =
  | { choose: 'ours' }
  | { choose: 'theirs' }
  | { value: Value }

function conflictKey(mark: string, path: string): string {
  return `${mark}\t${path}`
}

export class MergeSession {
  private merged: Dataset
  private open: Map<string, Conflict>
  private resolutions = new Map<string, Resolution>()

  constructor(base: Dataset, ours: Dataset, theirs: Dataset) {
    const result = mergeDataset(base, ours, theirs)
    // the merge keeps `ours` provisionally at a conflict; the session records the rest
    this.merged = new Map(result.merged)
    this.open = new Map(result.conflicts.map(c => [conflictKey(c.mark, c.path), c]))
  }

  // The unresolved conflicts.
  conflicts(): Array<Conflict> {
    return [...this.open.values()].filter(
      c => !this.resolutions.has(conflictKey(c.mark, c.path)),
    )
  }

  // Whether every conflict has a resolution.
  resolved(): boolean {
    return this.conflicts().length === 0
  }

  // Resolve one conflict by choosing a side or supplying a value.
  resolve(mark: string, path: string, resolution: Resolution): void {
    const key = conflictKey(mark, path)
    if (this.open.has(key)) {
      this.resolutions.set(key, resolution)
    }
  }

  // The merged dataset with all recorded resolutions applied. A field is set to the
  // chosen side's value (or a custom value); choosing a value that clears the field
  // removes it.
  result(): Dataset {
    let out = this.merged
    for (const [key, conflict] of this.open) {
      const resolution = this.resolutions.get(key)
      if (resolution === undefined) {
        continue
      }
      const value =
        'value' in resolution
          ? resolution.value
          : resolution.choose === 'ours'
            ? conflict.a
            : conflict.b
      if (value.kind === 'null') {
        out = applyChanges(out, [
          { type: 'field.remove', mark: conflict.mark, field: conflict.path, before: conflict.a },
        ])
      } else {
        out = applyChanges(out, [
          { type: 'field.set', mark: conflict.mark, field: conflict.path, before: conflict.a, after: value },
        ])
      }
    }
    return out
  }
}
