import { describe, it, expect } from 'vitest'
import { record, text } from '@/base/make'
import { datasetOf } from '@/diff/change'
import { MemoryChunkStore } from '@/store/chunk-store'
import { MemoryRefStore } from '@/store/ref-store'
import { Repository } from '@/repo/repo'
import { MemoryRefLog } from '@/reflog/reflog'
import { buildMarkIndex, markHistory } from '@/history/history'
import { MergeSession } from '@/merge/session'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

function repo(reflog = false) {
  return new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    undefined,
    reflog ? { reflog: new MemoryRefLog() } : {},
  )
}

describe('reflog and recovery', () => {
  it('records every head move and recovers a lost head by reset', () => {
    const r = repo(true)
    const c1 = r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const c2 = r.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('b') } })]))
    expect(c1.ok && c2.ok).toBe(true)
    if (!c1.ok || !c2.ok) return

    const log = r.reflog('main')
    expect(log.map(e => e.op)).toEqual(['commit', 'commit'])
    expect(log[0]!.to).toBe(c2.commit)

    // simulate a bad move, then recover to the logged prior head
    r.resetBranch('main', c1.commit, 'oops')
    expect(r.head('main')).toBe(c1.commit)
    r.resetBranch('main', c2.commit, 'recover')
    expect(r.head('main')).toBe(c2.commit)
    expect(r.checkoutBranch('main').get(M1)!.fields.get('term')).toEqual(text('b'))
  })
})

describe('tags', () => {
  it('names an immutable release and keeps it alive through gc', () => {
    const r = repo()
    const c1 = r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    if (!c1.ok) return
    expect(r.createTag('v1', c1.commit)).toBe(true)
    // tag is immutable: a second create fails
    expect(r.createTag('v1', c1.commit)).toBe(false)
    expect(r.tag('v1')).toBe(c1.commit)

    // move the branch on, then gc: the tagged release survives
    r.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('b') } })]))
    r.gc()
    expect(r.checkout(r.tag('v1')!).get(M1)!.fields.get('term')).toEqual(text('a'))
  })
})

describe('fsck', () => {
  it('verifies a healthy repo and detects corruption', () => {
    const chunks = new MemoryChunkStore()
    const r = new Repository(chunks, new MemoryRefStore())
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const healthy = r.fsck()
    expect(healthy.ok).toBe(true)
    expect(healthy.checked).toBeGreaterThan(0)
    expect(healthy.missing).toEqual([])

    // corrupt a chunk in place: fsck detects the hash mismatch
    const someHash = chunks.keys()[0]!
    ;(chunks as unknown as { map: Map<string, string> }).map.set(someHash, 'tampered')
    const bad = r.fsck()
    expect(bad.ok).toBe(false)
    expect(bad.corrupt.length + bad.missing.length).toBeGreaterThan(0)
  })
})

describe('mark index', () => {
  it('finds only the commits that touched a record', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    // c2 touches only M2
    r.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'word', mark: M2, fields: { term: text('x') } }),
    ]))
    // c3 touches M1
    r.commit('main', meta(3, 'c3'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('b') } }),
      record({ type: 'word', mark: M2, fields: { term: text('x') } }),
    ]))
    const index = buildMarkIndex(r, 'main')
    // M1 changed in c1 and c3, not c2
    const hist = markHistory(r, 'main', M1, index)
    expect(hist.map(h => h.message)).toEqual(['c3', 'c1'])
    // M2 first appeared in c2 only
    expect(markHistory(r, 'main', M2, index).map(h => h.message)).toEqual(['c2'])
  })
})

describe('cherry-pick, revert, rebase', () => {
  it('cherry-picks a commit onto another branch', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    r.createBranch('feature', { branch: 'main' })
    const fc = r.commit('feature', meta(2, 'add M2'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'word', mark: M2, fields: { term: text('feature') } }),
    ]))
    if (!fc.ok) return
    const res = r.cherryPick('main', fc.commit, meta(3, 'cherry'))
    expect(res.ok).toBe(true)
    expect(r.checkoutBranch('main').get(M2)!.fields.get('term')).toEqual(text('feature'))
  })

  it('reverts a commit', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const c2 = r.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('b') } })]))
    if (!c2.ok) return
    const res = r.revert('main', c2.commit, meta(3, 'revert c2'))
    expect(res.ok).toBe(true)
    // back to the pre-c2 value
    expect(r.checkoutBranch('main').get(M1)!.fields.get('term')).toEqual(text('a'))
  })

  it('rebases a branch onto another', () => {
    const r = repo()
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    r.createBranch('feature', { branch: 'main' })
    // feature adds M2
    r.commit('feature', meta(2, 'feat'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'word', mark: M2, fields: { term: text('f') } }),
    ]))
    // main advances M1 independently
    r.commit('main', meta(3, 'main2'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a2') } })]))

    const res = r.rebase('feature', 'main')
    expect(res.ok).toBe(true)
    const head = r.checkoutBranch('feature')
    // feature now has main's M1 update and its own M2
    expect(head.get(M1)!.fields.get('term')).toEqual(text('a2'))
    expect(head.get(M2)!.fields.get('term')).toEqual(text('f'))
  })
})

describe('merge session (conflict resolution)', () => {
  it('resolves a same-field conflict by choosing a side', () => {
    const base = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('base') } })])
    const ours = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('ours') } })])
    const theirs = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('theirs') } })])
    const session = new MergeSession(base, ours, theirs)
    expect(session.resolved()).toBe(false)
    expect(session.conflicts().length).toBe(1)

    session.resolve(M1, 'term', { choose: 'theirs' })
    expect(session.resolved()).toBe(true)
    expect(session.result().get(M1)!.fields.get('term')).toEqual(text('theirs'))
  })

  it('resolves with a custom value', () => {
    const base = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('base') } })])
    const ours = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('ours') } })])
    const theirs = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('theirs') } })])
    const session = new MergeSession(base, ours, theirs)
    session.resolve(M1, 'term', { value: text('reconciled') })
    expect(session.result().get(M1)!.fields.get('term')).toEqual(text('reconciled'))
  })
})
