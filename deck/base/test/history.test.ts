import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { blame, recordHistory, bisect } from '@term/base/code/history/history'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('gloss', { base: 'text' }),
])

function repo(): Repository {
  return new Repository(new MemoryChunkStore(), new MemoryRefStore(), roleBase([wordForm]))
}

function ds(records: Parameters<typeof datasetOf>[0]): Dataset {
  return datasetOf(records)
}

const meta = (time: number, message: string) => ({ author: 'alice', time, message })

describe('history: blame', () => {
  it('reports the commit that last set each field', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), ds([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const c2 = r.commit(
      'main',
      meta(2, 'add gloss'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('a'), gloss: text('g1') } })]),
    )
    const c3 = r.commit(
      'main',
      meta(3, 'edit term'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('b'), gloss: text('g1') } })]),
    )
    expect(c2.ok && c3.ok).toBe(true)

    const b = blame(r, 'main', M1)
    const byField = new Map(b.map(x => [x.field, x]))
    // term was last changed in c3
    expect(byField.get('term')!.commit).toBe((c3 as { commit: string }).commit)
    expect(byField.get('term')!.message).toBe('edit term')
    // gloss was set in c2 and untouched since
    expect(byField.get('gloss')!.commit).toBe((c2 as { commit: string }).commit)
    expect(byField.get('gloss')!.message).toBe('add gloss')
  })
})

describe('history: recordHistory', () => {
  it('lists only the commits where the record changed', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), ds([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    // c2 changes an unrelated record; M1 is unchanged
    r.commit(
      'main',
      meta(2, 'c2'),
      ds([
        record({ type: 'word', mark: M1, fields: { term: text('a') } }),
        record({ type: 'word', mark: M2, fields: { term: text('x') } }),
      ]),
    )
    // c3 changes M1
    r.commit(
      'main',
      meta(3, 'c3'),
      ds([
        record({ type: 'word', mark: M1, fields: { term: text('b') } }),
        record({ type: 'word', mark: M2, fields: { term: text('x') } }),
      ]),
    )
    const h = recordHistory(r, 'main', M1)
    // newest first: c3 (changed) and c1 (introduced), not c2
    expect(h.map(e => e.message)).toEqual(['c3', 'c1'])
  })
})

describe('history: bisect', () => {
  it('finds the first commit where a condition holds', () => {
    const r = repo()
    const commits: Array<string> = []
    for (let i = 1; i <= 6; i++) {
      const gloss = i >= 4 ? text('bad') : text('ok')
      const res = r.commit(
        'main',
        meta(i, `c${i}`),
        ds([record({ type: 'word', mark: M1, fields: { term: text('a'), gloss } })]),
      )
      expect(res.ok).toBe(true)
      if (res.ok) commits.push(res.commit)
    }
    // the "bad" state first appears at c4 (index 3)
    const first = bisect(r, 'main', dataset => {
      const rec = dataset.get(M1)
      return rec !== undefined && rec.fields.get('gloss')?.kind === 'text' &&
        (rec.fields.get('gloss') as { value: string }).value === 'bad'
    })
    expect(first).toBe(commits[3])
  })
})
