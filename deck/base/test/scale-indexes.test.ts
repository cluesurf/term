import { describe, it, expect } from 'vitest'
import { record, text, integer, ref } from '@/base/make'
import type { RecordNode } from '@/base/type'
import { datasetOf, emptyDataset } from '@/diff/change'
import { diffDataset } from '@/diff/diff'
import { query, QueryableProjection } from '@/query/query'
import { OrderedIndex } from '@/query/ordered-index'
import { ReferenceIndex } from '@/lookup/reference-index'
import { removeWithAction } from '@/identity/lifecycle'

const mk = (i: number): string =>
  `${i + 1}0000000-0000-4000-8000-000000000000`

describe('OrderedIndex', () => {
  it('answers range, prefix, and ordered reads', () => {
    const idx = new OrderedIndex()
    idx.set(mk(0), integer(3))
    idx.set(mk(1), integer(1))
    idx.set(mk(2), integer(5))
    idx.set(mk(3), integer(2))

    // gte 3 -> ranks 3 and 5
    expect(idx.range(integer(3), true, undefined, false).sort()).toEqual([mk(0), mk(2)].sort())
    // lt 3 -> ranks 1 and 2
    expect(idx.range(undefined, false, integer(3), false).sort()).toEqual([mk(1), mk(3)].sort())
    // ascending order by value
    expect(idx.ordered('asc')).toEqual([mk(1), mk(3), mk(0), mk(2)])
    expect(idx.ordered('desc')).toEqual([mk(2), mk(0), mk(3), mk(1)])
  })

  it('supports text prefix and reflects removals', () => {
    const idx = new OrderedIndex()
    idx.set(mk(0), text('apple'))
    idx.set(mk(1), text('apricot'))
    idx.set(mk(2), text('banana'))
    expect(idx.prefix('ap').sort()).toEqual([mk(0), mk(1)].sort())
    idx.remove(mk(0))
    expect(idx.prefix('ap')).toEqual([mk(1)])
  })
})

describe('QueryableProjection ordered index', () => {
  it('uses an ordered index for range and prefix queries and stays in sync', () => {
    const p = new QueryableProjection()
    p.declareOrderedIndex('word', 'rank')
    p.declareOrderedIndex('word', 'term')
    p.apply(
      diffDataset(
        emptyDataset(),
        datasetOf([
          record({ type: 'word', mark: mk(0), fields: { term: text('apple'), rank: integer(3) } }),
          record({ type: 'word', mark: mk(1), fields: { term: text('apricot'), rank: integer(1) } }),
          record({ type: 'word', mark: mk(2), fields: { term: text('banana'), rank: integer(5) } }),
        ]),
      ),
    )
    expect(p.hasOrderedIndex('word', 'rank')).toBe(true)
    expect(p.find(query('word').gte('rank', integer(3))).map(r => r.mark).sort()).toEqual(
      [mk(0), mk(2)].sort(),
    )
    expect(p.find(query('word').prefix('term', 'ap')).map(r => r.mark).sort()).toEqual(
      [mk(0), mk(1)].sort(),
    )

    // update a value; the ordered index moves it
    p.apply(
      diffDataset(
        datasetOf([record({ type: 'word', mark: mk(1), fields: { term: text('apricot'), rank: integer(1) } })]),
        datasetOf([record({ type: 'word', mark: mk(1), fields: { term: text('apricot'), rank: integer(9) } })]),
      ),
    )
    expect(p.find(query('word').gte('rank', integer(3))).map(r => r.mark).sort()).toEqual(
      [mk(0), mk(1), mk(2)].sort(),
    )
  })
})

describe('ReferenceIndex', () => {
  function ds(): Array<RecordNode> {
    return [
      record({ type: 'word', mark: mk(0), fields: { term: text('a') } }),
      record({ type: 'word', mark: mk(1), fields: { term: text('b'), root: ref(mk(0)) } }),
      record({ type: 'word', mark: mk(2), fields: { term: text('c'), root: ref(mk(0)) } }),
    ]
  }

  it('reports referrers in O(referrers) and matches the scan', () => {
    const dataset = datasetOf(ds())
    const idx = ReferenceIndex.fromDataset(dataset)
    expect(idx.referrers(mk(0)).sort()).toEqual([mk(1), mk(2)].sort())
    expect(idx.referrers(mk(1))).toEqual([])
  })

  it('updates when a record is re-indexed or removed', () => {
    const dataset = datasetOf(ds())
    const idx = ReferenceIndex.fromDataset(dataset)
    // mk(1) stops referencing mk(0)
    idx.reindex(mk(1), record({ type: 'word', mark: mk(1), fields: { term: text('b') } }))
    expect(idx.referrers(mk(0))).toEqual([mk(2)])
    // mk(2) removed entirely
    idx.reindex(mk(2), undefined)
    expect(idx.referrers(mk(0))).toEqual([])
  })

  it('feeds referrers into removeWithAction to skip the scan', () => {
    const dataset = datasetOf(ds())
    const idx = ReferenceIndex.fromDataset(dataset)
    const res = removeWithAction(dataset, mk(0), 'restrict', idx.referrers(mk(0)))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.blockedBy.sort()).toEqual([mk(1), mk(2)].sort())
    }
  })
})
