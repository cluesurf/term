import type { RecordNode, Value } from '@term/base/code/base/type'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'
import { emptyDataset, type Change, type Dataset } from '@term/base/code/diff/change'
import { applyChanges } from '@term/base/code/patch/patch'

// A projection consumes the change feed, builds a queryable structure, and can
// rebuild from history. Any read surface (a relational cache, a search index, an
// in-memory trie like clue.surf/find) is a projection. This is the built-in
// in-memory queryable projection; custom ones implement the same shape.
//
// See note/library/base/design/custom-projections.md and
// note/library/base/08-database-projection.md.

export interface Projection {
  // apply a commit's changes incrementally
  apply(changes: Array<Change>): void
  // the commit hash this projection currently reflects, for lag reporting
  servingCommit(): string | undefined
  setServingCommit(hash: string): void
}

// The same contract for a projection that lives behind a network call, which a relational
// or search target does. Kept separate rather than making `Projection` async, because an
// in-memory projection is genuinely synchronous and forcing a promise on it would make
// every caller await something that never yields.
//
// The commit travels WITH the changes here, unlike `Projection`, where it is set
// afterwards. A remote projection must record both in one transaction, or a crash between
// them leaves it either losing a commit or replaying one.
export interface AsyncProjection {
  apply(input: {
    commit: string
    changes: Array<Change>
  }): Promise<{ applied: boolean }>
  serving(): Promise<string | undefined>
  rebuild(input: { commit: string; dataset: Dataset }): Promise<unknown>
}

export class MemoryProjection implements Projection {
  protected data: Dataset = emptyDataset()
  private commit: string | undefined

  apply(changes: Array<Change>): void {
    this.data = applyChanges(this.data, changes)
  }

  servingCommit(): string | undefined {
    return this.commit
  }

  setServingCommit(hash: string): void {
    this.commit = hash
  }

  size(): number {
    return this.data.size
  }

  get(mark: string): RecordNode | undefined {
    return this.data.get(mark)
  }

  all(): Array<RecordNode> {
    return [...this.data.values()]
  }

  byType(type: string): Array<RecordNode> {
    return this.all().filter(r => r.type === type)
  }

  // Records of a type whose field equals a value (equality by canonical form).
  where(type: string, field: string, value: Value): Array<RecordNode> {
    const target = canonicalizeValue(value)
    return this.byType(type).filter(r => {
      const v = r.fields.get(field)
      return v !== undefined && canonicalizeValue(v) === target
    })
  }

  filter(pred: (r: RecordNode) => boolean): Array<RecordNode> {
    return this.all().filter(pred)
  }
}
