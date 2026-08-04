import { describe, it, expect } from 'vitest'
import { record, text, set, item } from '@/base/make'
import { datasetOf } from '@/diff/change'
import { diffDataset } from '@/diff/diff'
import { applyChanges } from '@/patch/patch'
import { canonicalizeRecord } from '@/canon/canonicalize'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

function ds(records: Parameters<typeof datasetOf>[0]) {
  return datasetOf(records)
}

describe('diff and patch round-trip', () => {
  it('apply(diff(a, b)) to a yields b', () => {
    const a = ds([
      record({ type: 'word', mark: M1, fields: { term: text('foo') } }),
      record({ type: 'word', mark: M2, fields: { term: text('bar') } }),
    ])
    const b = ds([
      record({ type: 'word', mark: M1, fields: { term: text('foo2') } }),
      record({
        type: 'word',
        mark: M2,
        fields: { term: text('bar'), note: text('added') },
      }),
    ])
    const changes = diffDataset(a, b)
    const result = applyChanges(a, changes)
    for (const mark of b.keys()) {
      expect(canonicalizeRecord(result.get(mark)!)).toBe(
        canonicalizeRecord(b.get(mark)!),
      )
    }
    expect(result.size).toBe(b.size)
  })

  it('produces no changes for a reordered set', () => {
    const a = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('a')), item(text('b'))]) },
      }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('b')), item(text('a'))]) },
      }),
    ])
    expect(diffDataset(a, b)).toEqual([])
  })

  it('detects add and remove of records', () => {
    const a = ds([record({ type: 'word', mark: M1, fields: {} })])
    const b = ds([record({ type: 'word', mark: M2, fields: {} })])
    const changes = diffDataset(a, b)
    const types = changes.map(c => c.type).sort()
    expect(types).toEqual(['record.add', 'record.remove'])
  })
})
