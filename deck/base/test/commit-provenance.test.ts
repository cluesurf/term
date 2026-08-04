import { describe, it, expect } from 'vitest'
import { record, text, integer, ref } from '@/base/make'
import { datasetOf } from '@/diff/change'
import { diffDataset } from '@/diff/diff'
import { emptyDataset } from '@/diff/change'
import { encodeChanges, decodeChanges } from '@/commit/changeset'
import { signCommitObject, verifyCommitObject, readCommit, type Commit } from '@/commit/commit'
import { generateKeypair } from '@/access/sign'
import { MemoryChunkStore } from '@/store/chunk-store'
import { MemoryRefStore } from '@/store/ref-store'
import { Repository } from '@/repo/repo'
import { MemoryProjection } from '@/project/projection'
import { sync, commitChanges } from '@/project/feed'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

describe('changeset codec', () => {
  it('round-trips every change kind', () => {
    const before = datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a'), rank: integer(1) } }),
      record({ type: 'word', mark: M2, fields: { term: text('gone') } }),
    ])
    const after = datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('b'), root: ref(M2) } }),
      // M2 removed, a new record added
      record({ type: 'word', mark: '33333333-3333-4333-8333-333333333333', fields: { term: text('new') } }),
    ])
    const changes = diffDataset(before, after)
    const decoded = decodeChanges(encodeChanges(changes))
    expect(decoded).toEqual(changes)
  })

  it('distinguishes a first set from a set over an existing value', () => {
    const changes = diffDataset(
      datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]),
      datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a'), gloss: text('g') } })]),
    )
    const decoded = decodeChanges(encodeChanges(changes))
    expect(decoded).toEqual(changes)
    const setGloss = decoded.find(c => c.type === 'field.set' && c.field === 'gloss')
    expect(setGloss && setGloss.type === 'field.set' && setGloss.before).toBeUndefined()
  })
})

describe('signed commits', () => {
  it('signs and verifies a commit, and rejects tampering', () => {
    const kp = generateKeypair()
    const base: Commit = {
      root: 'sha256:deadbeef',
      parents: [],
      author: 'alice',
      time: 1,
      message: 'x',
      validation: { schema: 'passed', errors: 0, warnings: 0 },
    }
    const signed = signCommitObject(base, kp)
    expect(verifyCommitObject(signed)).toBe(true)
    // tamper with the message: signature no longer verifies
    expect(verifyCommitObject({ ...signed, message: 'y' })).toBe(false)
    // unsigned commit does not verify
    expect(verifyCommitObject(base)).toBe(false)
  })

  it('signs every commit made through a repository configured with a signer', () => {
    const kp = generateKeypair()
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), undefined, { signer: kp })
    const res = repo.commit(
      'main',
      meta(1, 'add'),
      datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]),
    )
    expect(res.ok).toBe(true)
    if (res.ok) {
      const commit = repo.readCommit(res.commit)
      expect(commit.signer).toBe(kp.publicKey)
      expect(verifyCommitObject(commit)).toBe(true)
    }
  })
})

describe('commit change sets', () => {
  it('records the change set on each commit and serves it to the feed', () => {
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore())
    const c1 = repo.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
    ]))
    const c2 = repo.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('b') } }),
      record({ type: 'word', mark: M2, fields: { term: text('n') } }),
    ]))
    expect(c1.ok && c2.ok).toBe(true)
    if (!c1.ok || !c2.ok) return

    // the commit stored its change set
    const stored = repo.commitChangeset(c2.commit)!
    expect(stored.length).toBeGreaterThan(0)

    // the feed's forward step returns exactly the stored change set
    const fromFeed = commitChanges(repo, c1.commit, c2.commit)
    expect(fromFeed).toEqual(stored)

    // and a projection synced through the feed matches a full checkout
    const proj = new MemoryProjection()
    sync(repo, 'main', proj)
    const full = repo.checkoutBranch('main')
    expect(proj.get(M1)!.fields.get('term')).toEqual(full.get(M1)!.fields.get('term'))
    expect(proj.get(M2)!.fields.get('term')).toEqual(text('n'))
  })

  it('advances a projection incrementally and matches a from-empty rebuild', () => {
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore())
    repo.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const live = new MemoryProjection()
    sync(repo, 'main', live) // from empty

    repo.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a2') } }),
      record({ type: 'word', mark: M2, fields: { term: text('b') } }),
    ]))
    sync(repo, 'main', live) // incremental advance

    const fresh = new MemoryProjection()
    fresh.apply(commitChanges(repo, undefined, repo.head('main')!))
    expect(live.get(M1)!.fields.get('term')).toEqual(fresh.get(M1)!.fields.get('term'))
    expect(live.get(M2)!.fields.get('term')).toEqual(fresh.get(M2)!.fields.get('term'))
    expect(live.size()).toBe(fresh.size())
  })
})
