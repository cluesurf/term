import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { hashBytes } from '@term/base/code/canon/hash'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import type { RefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { removeMatching, redactMatching, ConcurrentErasureError } from '@term/base/code/erase/erase'
import { isRedacted } from '@term/base/code/redact/redact'
import { sweepObjectStore } from '@term/base/code/gc/gc'
import { MemoryObjectStore } from '@term/base/code/store/object-store'
import { chunkKey } from '@term/base/code/store/r2-chunk-store'
import { MemoryOffHistoryStore, putOffHistory } from '@term/base/code/offhistory/store'

const A = '11111111-1111-4111-8111-111111111111'
const SECRET_MARK = '22222222-2222-4222-8222-222222222222'
const SECRET = 'SSN-123-45-6789'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

// No live chunk anywhere still contains the erased text: the hard-erasure guarantee.
function noChunkContains(chunks: MemoryChunkStore, needle: string): boolean {
  return chunks.keys().every(k => !chunks.get(k)!.includes(needle))
}

describe('garbage collection', () => {
  it('keeps everything reachable and reclaims stray chunks', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    repo.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('a') } })]))
    repo.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('b') } })]))

    // a gc with all reachable removes nothing
    const clean = repo.gc()
    expect(clean.removed).toBe(0)

    // an orphaned chunk (not on any tree) is reclaimed
    const orphan = chunks.put('orphaned-bytes')
    expect(chunks.has(orphan)).toBe(true)
    const swept = repo.gc()
    expect(swept.removed).toBe(1)
    expect(chunks.has(orphan)).toBe(false)
    // history still intact after gc
    expect(repo.checkoutBranch('main').get(A)!.fields.get('term')).toEqual(text('b'))
    expect(repo.log('main').length).toBe(2)
  })

  it('does not reclaim older history reachable through parents', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    const c1 = repo.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('a') } })]))
    repo.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('b') } })]))
    repo.gc()
    // the first commit's state is still checkoutable (its chunks survived gc)
    if (c1.ok) {
      expect(repo.checkout(c1.commit).get(A)!.fields.get('term')).toEqual(text('a'))
    }
  })
})

describe('hard erasure from history', () => {
  function seed(): { chunks: MemoryChunkStore; repo: Repository; contentHash: string } {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    const secret = record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } })
    const contentHash = hashBytes(canonicalizeRecord(secret))
    repo.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('a') } }),
      secret,
    ]))
    // a later commit edits an unrelated record; the secret persists in history
    repo.commit('main', meta(2, 'c2'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('b') } }),
      secret,
    ]))
    // the secret's chunk really is in the store before erasure
    expect(chunks.has(contentHash)).toBe(true)
    return { chunks, repo, contentHash }
  }

  it('removes matching records from all commits and physically deletes the bytes', () => {
    const { chunks, repo, contentHash } = seed()
    const report = repo.eraseFromHistory(removeMatching(n => n.type === 'person'))

    expect(report.rewritten).toBe(2)
    expect(report.erasedOccurrences).toBe(2) // once per commit
    expect(report.gc!.removed).toBeGreaterThan(0)

    // the record is gone from the current state and its original chunk is deleted
    expect(repo.checkoutBranch('main').has(SECRET_MARK)).toBe(false)
    expect(chunks.has(contentHash)).toBe(false)
    // the strong guarantee: no surviving chunk contains the secret at all
    expect(noChunkContains(chunks, SECRET)).toBe(true)
    // the unrelated data and history shape survive
    expect(repo.checkoutBranch('main').get(A)!.fields.get('term')).toEqual(text('b'))
    expect(repo.log('main').length).toBe(2)
  })

  it('redacts to a tombstone, keeping the mark resolvable but erasing the content', () => {
    const { chunks, repo } = seed()
    repo.eraseFromHistory(
      redactMatching(n => n.type === 'person', { reason: 'gdpr', by: 'dpo', time: 5 }),
    )
    const head = repo.checkoutBranch('main')
    // the mark still resolves (references do not dangle) but is a tombstone
    expect(head.has(SECRET_MARK)).toBe(true)
    expect(isRedacted(head.get(SECRET_MARK)!)).toBe(true)
    // the secret content is physically gone
    expect(noChunkContains(chunks, SECRET)).toBe(true)
  })

  it('erases across every branch', () => {
    const { chunks, repo } = seed()
    // branch off, so the secret is reachable from two heads
    repo.createBranch('dev', { branch: 'main' })
    repo.commit('dev', meta(3, 'c3'), datasetOf([
      record({ type: 'word', mark: A, fields: { term: text('c') } }),
      record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } }),
    ]))

    const report = repo.eraseFromHistory(removeMatching(n => n.type === 'person'))
    expect(report.branches.sort()).toEqual(['dev', 'main'])
    expect(report.moved.length).toBe(2)

    // neither branch head has it, and no chunk anywhere holds the secret
    expect(repo.checkoutBranch('main').has(SECRET_MARK)).toBe(false)
    expect(repo.checkoutBranch('dev').has(SECRET_MARK)).toBe(false)
    expect(noChunkContains(chunks, SECRET)).toBe(true)
  })

  it('also deletes off-history content the erased record referenced', () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    const offHistory = new MemoryOffHistoryStore()
    const noteRef = putOffHistory(offHistory, SECRET)
    const id = noteRef.kind === 'blob' ? noteRef.hash.split(':')[1]! : ''
    repo.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'person', mark: SECRET_MARK, fields: { note: noteRef } }),
    ]))
    expect(offHistory.has(id)).toBe(true)

    const report = repo.eraseFromHistory(removeMatching(n => n.type === 'person'), { offHistory })
    expect(report.offHistoryDeleted).toBe(1)
    // the off-history side store no longer holds the content either
    expect(offHistory.has(id)).toBe(false)
    expect(offHistory.get(id)).toBeUndefined()
  })
})

describe('mirror garbage collection', () => {
  it('sweeps an object-store mirror against the repo reachable set', async () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    repo.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('a') } })]))

    // mirror every live chunk to an object store, plus one stale object
    const mirror = new MemoryObjectStore()
    for (const h of repo.reachableChunkHashes()) {
      await mirror.put(chunkKey(h), chunks.get(h)!)
    }
    await mirror.put(chunkKey(`sha256:${'0'.repeat(64)}`), 'orphaned')

    const reachableKeys = new Set([...repo.reachableChunkHashes()].map(chunkKey))
    const report = await sweepObjectStore(mirror, reachableKeys)
    expect(report.removed).toBe(1)
    expect(await mirror.get(chunkKey(`sha256:${'0'.repeat(64)}`))).toBeUndefined()
    // live chunks remain
    for (const h of repo.reachableChunkHashes()) {
      expect(await mirror.get(chunkKey(h))).toBeDefined()
    }
  })
})

// A ref store that can be told to fail every compare-and-swap, to simulate a branch
// head moving under an in-progress erasure.
class RacingRefStore implements RefStore {
  race = false
  constructor(private inner = new MemoryRefStore()) {}
  get(name: string): string | undefined {
    return this.inner.get(name)
  }
  compareAndSwap(name: string, expected: string | undefined, next: string): boolean {
    if (this.race) {
      return false
    }
    return this.inner.compareAndSwap(name, expected, next)
  }
  list(): Array<string> {
    return this.inner.list()
  }
  delete(name: string): void {
    this.inner.delete(name)
  }
}

describe('erasure safety under concurrency', () => {
  it('aborts and deletes nothing if a branch head moves during the rewrite', () => {
    const chunks = new MemoryChunkStore()
    const refs = new RacingRefStore()
    const repo = new Repository(chunks, refs)
    const secret = record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } })
    const contentHash = hashBytes(canonicalizeRecord(secret))
    repo.commit('main', meta(1, 'c1'), datasetOf([secret]))
    const headBefore = repo.head('main')

    // simulate a concurrent commit: the repoint compare-and-swap will now fail
    refs.race = true
    expect(() => repo.eraseFromHistory(removeMatching(n => n.type === 'person'))).toThrow(
      ConcurrentErasureError,
    )

    // nothing was deleted: the head is unchanged and the content is still present
    expect(repo.head('main')).toBe(headBefore)
    expect(chunks.has(contentHash)).toBe(true)
  })
})
