import type { Mark, Value } from '@term/base/code/base/type'
import { compareValues } from '@term/base/code/query/compare'

// An ordered index over one (type, field): the marks sorted by their field value, so
// range, prefix, and ordered reads are logarithmic-plus-output instead of a full scan.
// Entries are kept in a sorted array, re-sorted lazily on the first read after a write.
// That keeps reads sharp for the read-heavy projection workload; a write-heavy backend
// would swap in a balanced tree behind the same interface.
//
// See note/library/base/design/query-and-indexing.md and
// note/library/base/design/caching-and-query-performance.md.

type IndexEntry = { mark: Mark; value: Value }

export class OrderedIndex {
  private byMark = new Map<Mark, Value>()
  private sorted: Array<IndexEntry> = []
  private dirty = false

  set(mark: Mark, value: Value): void {
    this.byMark.set(mark, value)
    this.dirty = true
  }

  remove(mark: Mark): void {
    if (this.byMark.delete(mark)) {
      this.dirty = true
    }
  }

  private ensureSorted(): void {
    if (!this.dirty) {
      return
    }
    this.sorted = [...this.byMark].map(([mark, value]) => ({ mark, value }))
    // stable, deterministic order: by value, then by mark to break ties
    this.sorted.sort((a, b) => {
      const c = compareValues(a.value, b.value)
      return c !== 0 ? c : a.mark < b.mark ? -1 : a.mark > b.mark ? 1 : 0
    })
    this.dirty = false
  }

  // Lowest index whose value is >= the bound (a binary search lower bound).
  private lowerBound(bound: Value): number {
    let lo = 0
    let hi = this.sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      if (compareValues(this.sorted[mid]!.value, bound) < 0) {
        lo = mid + 1
      } else {
        hi = mid
      }
    }
    return lo
  }

  // Marks whose value falls in the given bounds, each side optional and open/closed.
  range(
    lo: Value | undefined,
    loInclusive: boolean,
    hi: Value | undefined,
    hiInclusive: boolean,
  ): Array<Mark> {
    this.ensureSorted()
    let start = lo === undefined ? 0 : this.lowerBound(lo)
    // for an exclusive lower bound, skip entries equal to it
    if (lo !== undefined && !loInclusive) {
      while (start < this.sorted.length && compareValues(this.sorted[start]!.value, lo) === 0) {
        start++
      }
    }
    const out: Array<Mark> = []
    for (let i = start; i < this.sorted.length; i++) {
      const v = this.sorted[i]!.value
      if (hi !== undefined) {
        const c = compareValues(v, hi)
        if (c > 0 || (c === 0 && !hiInclusive)) {
          break
        }
      }
      out.push(this.sorted[i]!.mark)
    }
    return out
  }

  // Marks whose text value begins with a prefix.
  prefix(p: string): Array<Mark> {
    this.ensureSorted()
    const start = this.lowerBound({ kind: 'text', value: p })
    const out: Array<Mark> = []
    for (let i = start; i < this.sorted.length; i++) {
      const v = this.sorted[i]!.value
      // the matching run is contiguous text values beginning at the lower bound
      if (v.kind !== 'text' || !v.value.startsWith(p)) {
        break
      }
      out.push(this.sorted[i]!.mark)
    }
    return out
  }

  // All marks in value order.
  ordered(dir: 'asc' | 'desc'): Array<Mark> {
    this.ensureSorted()
    const marks = this.sorted.map(e => e.mark)
    return dir === 'asc' ? marks : marks.reverse()
  }
}
