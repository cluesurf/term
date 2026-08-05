import { describe, it, expect } from 'vitest'
import { exportTree, exportArchive, manifestOf, archiveKey, worthCaching } from '@term/base/code/api/export'
import { countsOf, candidates, ripe, sweep, repair, packRemovable, GRACE_MS } from '@term/base/code/gc/refcount'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const wordForm = form('word', [property('term', { base: 'text' }, { constraints: [hold('need')] })])

function setup() {
  const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), roleBase([wordForm]))
  repo.commit('main', { author: 'a', time: 1, message: 'c' }, datasetOf([
    record({ type: 'word', mark: M2, fields: { term: text('two') } }),
    record({ type: 'word', mark: M1, fields: { term: text('one') } }),
  ]))
  return { repo, commit: repo.head('main')! }
}

describe('exportTree', () => {
  it('yields one readable file per record', () => {
    const { repo, commit } = setup()
    const entries = [...exportTree({ repo, commit })]
    expect(entries).toHaveLength(2)
    expect(entries[0]!.path).toMatch(/^word\/.*\.tree$/)
    expect(entries[0]!.bytes.toString('utf8')).toContain('word')
  })

  it('is deterministic, so an archive can be content-addressed', () => {
    const { repo, commit } = setup()
    const a = [...exportTree({ repo, commit })].map(e => e.path)
    const b = [...exportTree({ repo, commit })].map(e => e.path)
    expect(a).toEqual(b)
    expect(a).toEqual([...a].sort())
  })
})

describe('exportArchive', () => {
  it('puts the manifest first, so a truncated download is detectable', () => {
    const { repo, commit } = setup()
    const entries = [...exportArchive({ repo, commit, repository: 'term/make' })]
    expect(entries[0]!.path).toBe('manifest.json')
    const manifest = JSON.parse(entries[0]!.bytes.toString('utf8'))
    expect(manifest.commit).toBe(commit)
    expect(manifest.entries).toBe(2)
    expect(entries).toHaveLength(3)
  })

  it('names the commit, since a zip carries no proof of its own completeness', () => {
    const { repo, commit } = setup()
    const m = manifestOf({ repo, commit, repository: 'term/make' })
    expect(m.commit).toBe(commit)
    expect(m.records.map(r => r.mark)).toEqual([M1, M2].sort())
  })
})

describe('archive caching', () => {
  it('keys by commit, so a cached archive can never be stale', () => {
    expect(archiveKey({ repository: 'term/make', commit: 'sha256:abc', kind: 'tree' }))
      .toBe('export/tree/term/make/sha256:abc.zip')
  })

  it('caches heads and versions, not arbitrary history', () => {
    const heads = ['h1'], versions = ['v1']
    expect(worthCaching({ commit: 'h1', heads, versions })).toBe(true)
    expect(worthCaching({ commit: 'v1', heads, versions })).toBe(true)
    expect(worthCaching({ commit: 'old', heads, versions })).toBe(false)
  })
})

describe('reference counting', () => {
  const links = [
    { object: 'a', referrer: 'r1' },
    { object: 'a', referrer: 'r2' },
    { object: 'b', referrer: 'r1' },
  ]

  it('counts referrers', () => {
    const counts = countsOf(links)
    expect(counts.get('a')).toBe(2)
    expect(counts.get('b')).toBe(1)
  })

  it('reports zero-count objects as candidates, not deletions', () => {
    const found = candidates({ counts: countsOf(links), known: ['a', 'b', 'c'], now: 0 })
    expect(found.map(c => c.object)).toEqual(['c'])
  })

  it('holds a candidate for the grace period', () => {
    const found = candidates({ counts: new Map(), known: ['x'], now: 0 })
    expect(ripe({ candidates: found, now: GRACE_MS - 1 })).toHaveLength(0)
    expect(ripe({ candidates: found, now: GRACE_MS })).toHaveLength(1)
  })

  it('SPARES a candidate that reachability says is live', () => {
    // the property the whole design exists for: a lost increment must not delete data
    const removed: Array<string> = []
    const result = sweep({
      candidates: [{ object: 'a', count: 0, since: 0 }, { object: 'b', count: 0, since: 0 }],
      reachable: new Set(['a']),
      remove: o => removed.push(o),
    })
    expect(result.spared).toEqual(['a'])
    expect(result.deleted).toEqual(['b'])
    expect(removed).toEqual(['b'])
  })

  it('repairs drift and reports what was wrong', () => {
    const drifted = new Map([['a', 5], ['gone', 3]])
    const { counts, corrected } = repair({ counts: drifted, links })
    expect(counts.get('a')).toBe(2)
    expect(corrected).toContainEqual({ object: 'a', was: 5, now: 2 })
    expect(corrected).toContainEqual({ object: 'gone', was: 3, now: 0 })
  })

  it('removes a pack only when every object inside is unreferenced', () => {
    const counts = countsOf(links)
    expect(packRemovable({ contents: ['a', 'b'], counts })).toBe(false)
    expect(packRemovable({ contents: ['c', 'd'], counts })).toBe(true)
  })
})
