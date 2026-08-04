import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@/base/make'
import { datasetOf, emptyDataset } from '@/diff/change'
import { diffDataset } from '@/diff/diff'
import { query, QueryableProjection } from '@/query/query'
import type { RecordNode } from '@/base/type'

const marks = Array.from(
  { length: 5 },
  (_, i) => `${i + 1}0000000-0000-4000-8000-000000000000`,
)

function seed(): Array<RecordNode> {
  return [
    record({ type: 'word', mark: marks[0], fields: { term: text('apple'), rank: integer(3) } }),
    record({ type: 'word', mark: marks[1], fields: { term: text('apricot'), rank: integer(1) } }),
    record({ type: 'word', mark: marks[2], fields: { term: text('banana'), rank: integer(2) } }),
    record({ type: 'word', mark: marks[3], fields: { term: text('cherry'), rank: integer(5) } }),
    record({ type: 'sound', mark: marks[4], fields: { term: text('apple') } }),
  ]
}

function project(): QueryableProjection {
  const p = new QueryableProjection()
  p.apply(diffDataset(emptyDataset(), datasetOf(seed())))
  return p
}

describe('query', () => {
  it('filters by equality within a type', () => {
    const p = project()
    const out = p.find(query('word').eq('term', text('apple')))
    expect(out.map(r => r.mark)).toEqual([marks[0]])
  })

  it('supports comparison and prefix predicates', () => {
    const p = project()
    expect(p.find(query('word').gte('rank', integer(3))).map(r => r.mark).sort()).toEqual(
      [marks[0], marks[3]].sort(),
    )
    expect(p.find(query('word').prefix('term', 'ap')).map(r => r.mark).sort()).toEqual(
      [marks[0], marks[1]].sort(),
    )
  })

  it('orders, offsets, and limits', () => {
    const p = project()
    const out = p.find(query('word').order('rank', 'asc').limit(2))
    expect(out.map(r => r.fields.get('rank'))).toEqual([integer(1), integer(2)])
  })

  it('supports in and neq', () => {
    const p = project()
    expect(
      p.find(query('word').in('term', [text('apple'), text('banana')])).map(r => r.mark).sort(),
    ).toEqual([marks[0], marks[2]].sort())
    expect(p.find(query('word').neq('term', text('apple'))).length).toBe(3)
  })

  it('uses a declared index and keeps it in sync with the change feed', () => {
    const p = new QueryableProjection()
    p.declareIndex('word', 'term')
    p.apply(diffDataset(emptyDataset(), datasetOf(seed())))
    expect(p.hasIndex('word', 'term')).toBe(true)
    expect(p.lookup('word', 'term', text('apple'))).toEqual([marks[0]])

    // change a value: the index moves the mark
    const before = datasetOf(seed())
    const after = datasetOf(
      seed().map(r =>
        r.mark === marks[0]
          ? record({ type: 'word', mark: marks[0], fields: { term: text('avocado'), rank: integer(3) } })
          : r,
      ),
    )
    p.apply(diffDataset(before, after))
    expect(p.lookup('word', 'term', text('apple'))).toEqual([])
    expect(p.lookup('word', 'term', text('avocado'))).toEqual([marks[0]])
    // the query path returns the same result via the index
    expect(p.find(query('word').eq('term', text('avocado'))).map(r => r.mark)).toEqual([marks[0]])
  })

  it('declares an index after data is loaded and still indexes it', () => {
    const p = project()
    p.declareIndex('word', 'term')
    expect(p.lookup('word', 'term', text('banana'))).toEqual([marks[2]])
  })
})
