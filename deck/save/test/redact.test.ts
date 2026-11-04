import { describe, it, expect } from 'vitest'
import { record, text } from '@cluesurf/save/base/make'
import { canonicalizeRecord } from '@cluesurf/save/canon/canonicalize'
import { datasetOf } from '@cluesurf/save/diff/change'
import { MemoryChunkStore } from '@cluesurf/save/store/chunk-store'
import { MemoryRefStore } from '@cluesurf/save/store/ref-store'
import { Repository } from '@cluesurf/save/repo/repo'
import { redactInDataset, isRedacted } from '@cluesurf/save/redact/redact'
import { KeyStore, shredEncrypt, shredDecrypt } from '@cluesurf/save/redact/shred'

const M1 = '11111111-1111-4111-8111-111111111111'
const meta = (m: string) => ({ author: 'a', time: 1, message: m })

describe('redaction', () => {
  it('replaces a record with a tombstone as a commit', () => {
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore())
    repo.commit(
      'main',
      meta('add'),
      datasetOf([record({ type: 'word', mark: M1, fields: { term: text('secret') } })]),
    )
    const redacted = redactInDataset(repo.checkoutBranch('main'), M1, {
      reason: 'takedown',
      by: 'admin',
      time: 2,
    })
    const res = repo.commit('main', meta('redact'), redacted)
    expect(res.ok).toBe(true)

    const node = repo.checkoutBranch('main').get(M1)!
    expect(isRedacted(node)).toBe(true)
    // the original content is gone; the mark remains and still resolves
    expect(canonicalizeRecord(node)).not.toContain('secret')
    expect(node.mark).toBe(M1)
    // it is recorded in history as a normal commit
    expect(repo.log('main').length).toBe(2)
  })
})

describe('crypto-shredding', () => {
  it('reads an encrypted value, then loses it permanently once shredded', () => {
    const keys = new KeyStore()
    const shredded = shredEncrypt('personal data', keys)
    // readable while the key exists
    expect(shredDecrypt(shredded, keys)).toBe('personal data')
    // shred the key: the payload bytes are unchanged, but the value is unrecoverable
    const beforePayload = shredded.payload
    keys.shred(shredded.keyId)
    expect(shredDecrypt(shredded, keys)).toBeUndefined()
    expect(shredded.payload).toBe(beforePayload)
  })
})
