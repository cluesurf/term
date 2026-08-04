import { describe, it, expect } from 'vitest'
import { record, text } from '@/base/make'
import { canonicalizeRecord } from '@/canon/canonicalize'
import { datasetOf, type Dataset } from '@/diff/change'
import { form, property, hold, roleBase } from '@/form/form'
import { MemoryChunkStore } from '@/store/chunk-store'
import { MemoryRefStore } from '@/store/ref-store'
import { Repository } from '@/repo/repo'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('gloss', { base: 'text' }),
])

function repo(withRole = true): Repository {
  return new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    withRole ? roleBase([wordForm]) : undefined,
  )
}

function ds(records: Parameters<typeof datasetOf>[0]): Dataset {
  return datasetOf(records)
}

const meta = (message: string) => ({ author: 'alice', time: 1000, message })

describe('repository', () => {
  it('commits and checks out', () => {
    const r = repo()
    const res = r.commit(
      'main',
      meta('add foo'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('foo') } })]),
    )
    expect(res.ok).toBe(true)
    const head = r.head('main')!
    const back = r.checkout(head)
    expect(back.get(M1)!.fields.get('term')).toEqual(text('foo'))
  })

  it('records a commit chain in the log', () => {
    const r = repo()
    r.commit('main', meta('c1'), ds([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    r.commit(
      'main',
      meta('c2'),
      ds([
        record({ type: 'word', mark: M1, fields: { term: text('a') } }),
        record({ type: 'word', mark: M2, fields: { term: text('b') } }),
      ]),
    )
    const log = r.log('main')
    expect(log.length).toBe(2)
    expect(log[0]!.commit.message).toBe('c2')
    expect(log[0]!.commit.parents).toEqual([log[1]!.hash])
  })

  it('blocks a commit that fails validation', () => {
    const r = repo()
    const res = r.commit(
      'main',
      meta('bad'),
      ds([record({ type: 'word', mark: M1, fields: { gloss: text('g') } })]),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.diagnostics!.some(d => d.field === 'term')).toBe(true)
    }
    expect(r.head('main')).toBeUndefined()
  })

  it('auto-merges independent field edits across branches', () => {
    const r = repo()
    r.commit(
      'main',
      meta('base'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('t'), gloss: text('g') } })]),
    )
    r.createBranch('feature', { branch: 'main' })

    // feature edits gloss
    r.commit(
      'feature',
      meta('edit gloss'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('t'), gloss: text('G') } })]),
    )
    // main edits term
    r.commit(
      'main',
      meta('edit term'),
      ds([record({ type: 'word', mark: M1, fields: { term: text('T'), gloss: text('g') } })]),
    )

    const res = r.merge('main', 'feature', meta('merge'))
    expect(res.ok).toBe(true)
    if (res.ok) {
      const merged = r.checkout(res.commit).get(M1)!
      expect(merged.fields.get('term')).toEqual(text('T'))
      expect(merged.fields.get('gloss')).toEqual(text('G'))
    }
  })

  it('reports a conflict when the same field diverges', () => {
    const r = repo()
    r.commit('main', meta('base'), ds([record({ type: 'word', mark: M1, fields: { term: text('t'), gloss: text('g') } })]))
    r.createBranch('feature', { branch: 'main' })
    r.commit('feature', meta('a'), ds([record({ type: 'word', mark: M1, fields: { term: text('t'), gloss: text('pharmacy text') } })]))
    r.commit('main', meta('b'), ds([record({ type: 'word', mark: M1, fields: { term: text('t'), gloss: text('medical book') } })]))
    const res = r.merge('main', 'feature', meta('merge'))
    expect(res.ok).toBe(false)
    if (!res.ok) {
      expect(res.conflicts.length).toBe(1)
      expect(res.conflicts[0]!.path).toBe('gloss')
    }
  })

  it('diffs two commits to the changed marks', () => {
    const r = repo()
    r.commit('main', meta('c1'), ds([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const c1 = r.head('main')!
    r.commit(
      'main',
      meta('c2'),
      ds([
        record({ type: 'word', mark: M1, fields: { term: text('A') } }),
        record({ type: 'word', mark: M2, fields: { term: text('b') } }),
      ]),
    )
    const c2 = r.head('main')!
    expect(r.diffCommits(c1, c2)).toEqual(new Set([M1, M2]))
  })

  it('is a fast-forward merge when the target has no new commits', () => {
    const r = repo()
    r.commit('main', meta('base'), ds([record({ type: 'word', mark: M1, fields: { term: text('t') } })]))
    r.createBranch('feature', { branch: 'main' })
    r.commit('feature', meta('edit'), ds([record({ type: 'word', mark: M1, fields: { term: text('T') } })]))
    const res = r.merge('main', 'feature', meta('merge'))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(r.checkoutBranch('main').get(M1)!.fields.get('term')).toEqual(text('T'))
    }
  })
})
