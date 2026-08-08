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

  // The merged dataset with all recorded resolutions applied. How a resolution
  // is applied depends on the conflict's scope: a field value is set or removed,
  // a header (label / type) is rewritten, and a record delete-vs-edit is either
  // restored or deleted. The merge kept `ours` (a) provisionally, so a resolution
  // only has to move away from that.
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

      const scope = conflict.scope ?? 'field'

      if (scope === 'record') {
        // the provisional merged state holds the edited record; 'ours'/'theirs'
        // pick the record (restore) or null (delete)
        if (value.kind === 'record') {
          out = applyChanges(out, [
            { type: 'record.add', mark: conflict.mark, value: value.record },
          ])
        } else {
          out = applyChanges(out, [
            {
              type: 'record.remove',
              mark: conflict.mark,
              before: out.get(conflict.mark)!,
            },
          ])
        }
        continue
      }

      if (scope === 'label') {
        out = applyChanges(out, [
          {
            type: 'record.relabel',
            mark: conflict.mark,
            before: undefined,
            after: value.kind === 'text' ? value.value : undefined,
          },
        ])
        continue
      }

      if (scope === 'type') {
        // type is required, so a resolution that clears it keeps the current type
        if (value.kind === 'text') {
          const current = out.get(conflict.mark)
          out = applyChanges(out, [
            {
              type: 'record.retype',
              mark: conflict.mark,
              before: current?.type ?? value.value,
              after: value.value,
            },
          ])
        }
        continue
      }

      // scope 'field'
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
