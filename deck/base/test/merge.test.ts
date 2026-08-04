import { describe, it, expect } from 'vitest'
import { record, text, set, log, item } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { mergeDataset } from '@term/base/code/merge/merge'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'

const M1 = '11111111-1111-4111-8111-111111111111'

function ds(records: Parameters<typeof datasetOf>[0]) {
  return datasetOf(records)
}

function canon(d: Dataset): string {
  return [...d.keys()]
    .sort()
    .map(m => `${m}=${canonicalizeRecord(d.get(m)!)}`)
    .join('|')
}

describe('three-way merge', () => {
  it('auto-merges edits to different fields', () => {
    const base = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('foo'), gloss: text('g') },
      }),
    ])
    const a = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('FOO'), gloss: text('g') },
      }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('foo'), gloss: text('G') },
      }),
    ])
    const { merged, conflicts } = mergeDataset(base, a, b)
    expect(conflicts).toEqual([])
    const m = merged.get(M1)!
    expect(m.fields.get('term')).toEqual(text('FOO'))
    expect(m.fields.get('gloss')).toEqual(text('G'))
  })

  it('conflicts on concurrent edits to the same field', () => {
    const base = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('g') } }),
    ])
    const a = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('pharmacy text') } }),
    ])
    const b = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('medical book') } }),
    ])
    const { conflicts } = mergeDataset(base, a, b)
    expect(conflicts.length).toBe(1)
    expect(conflicts[0]!.path).toBe('gloss')
    expect(conflicts[0]!.a).toEqual(text('pharmacy text'))
    expect(conflicts[0]!.b).toEqual(text('medical book'))
  })

  it('takes a value when only one side changed it', () => {
    const base = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('g') } }),
    ])
    const a = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('new') } }),
    ])
    const b = ds([
      record({ type: 'word', mark: M1, fields: { gloss: text('g') } }),
    ])
    const { merged, conflicts } = mergeDataset(base, a, b)
    expect(conflicts).toEqual([])
    expect(merged.get(M1)!.fields.get('gloss')).toEqual(text('new'))
  })

  it('unions a set (add-wins) with no conflict', () => {
    const base = ds([
      record({ type: 'word', mark: M1, fields: { tags: set([item(text('x'))]) } }),
    ])
    const a = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('x')), item(text('a'))]) },
      }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('x')), item(text('b'))]) },
      }),
    ])
    const { merged, conflicts } = mergeDataset(base, a, b)
    expect(conflicts).toEqual([])
    const tags = merged.get(M1)!.fields.get('tags')!
    const values =
      tags.kind === 'collection'
        ? tags.items.map(i => (i.value.kind === 'text' ? i.value.value : '')).sort()
        : []
    expect(values).toEqual(['a', 'b', 'x'])
  })

  it('honors a set removal from one side', () => {
    const base = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('x')), item(text('y'))]) },
      }),
    ])
    const a = ds([
      record({ type: 'word', mark: M1, fields: { tags: set([item(text('x'))]) } }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { tags: set([item(text('x')), item(text('y'))]) },
      }),
    ])
    const { merged } = mergeDataset(base, a, b)
    const tags = merged.get(M1)!.fields.get('tags')!
    const values =
      tags.kind === 'collection'
        ? tags.items.map(i => (i.value.kind === 'text' ? i.value.value : ''))
        : []
    expect(values.sort()).toEqual(['x'])
  })

  it('unions an append-only log losslessly', () => {
    const base = ds([
      record({ type: 'word', mark: M1, fields: { prov: log([item(text('src1'))]) } }),
    ])
    const a = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { prov: log([item(text('src1')), item(text('src2'))]) },
      }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { prov: log([item(text('src1')), item(text('src3'))]) },
      }),
    ])
    const { merged } = mergeDataset(base, a, b)
    const prov = merged.get(M1)!.fields.get('prov')!
    const values =
      prov.kind === 'collection'
        ? prov.items.map(i => (i.value.kind === 'text' ? i.value.value : '')).sort()
        : []
    expect(values).toEqual(['src1', 'src2', 'src3'])
  })

  it('is commutative: merge(a, b) equals merge(b, a) on the auto-merged part', () => {
    const base = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('t'), gloss: text('g') },
      }),
    ])
    const a = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('T'), gloss: text('g') },
      }),
    ])
    const b = ds([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('t'), gloss: text('G') },
      }),
    ])
    const ab = mergeDataset(base, a, b).merged
    const ba = mergeDataset(base, b, a).merged
    expect(canon(ab)).toBe(canon(ba))
  })

  it('is idempotent: merge(base, a, a) equals a', () => {
    const base = ds([
      record({ type: 'word', mark: M1, fields: { term: text('t') } }),
    ])
    const a = ds([
      record({ type: 'word', mark: M1, fields: { term: text('T') } }),
    ])
    const { merged, conflicts } = mergeDataset(base, a, a)
    expect(conflicts).toEqual([])
    expect(canon(merged)).toBe(canon(a))
  })
})
