import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import {
  MemoryOffHistoryStore,
  putOffHistory,
  resolveOffHistory,
  isOffHistoryRef,
  offHistoryId,
} from '@term/base/code/offhistory/store'
import { hashRecord } from '@term/base/code/canon/hash'

const M1 = '11111111-1111-4111-8111-111111111111'

describe('off-history storage', () => {
  it('stores content off-history and references it from a record', () => {
    const store = new MemoryOffHistoryStore()
    const refValue = putOffHistory(store, 'personal data under erasure control')
    expect(isOffHistoryRef(refValue)).toBe(true)
    expect(resolveOffHistory(store, refValue)).toBe('personal data under erasure control')

    const rec = record({ type: 'person', mark: M1, fields: { note: refValue } })
    // the record only holds the reference, not the content
    const stored = rec.fields.get('note')!
    expect(stored.kind).toBe('blob')
    expect(offHistoryId(stored)).toBeDefined()
  })

  it('deletes content while the record hash stays stable', () => {
    const store = new MemoryOffHistoryStore()
    const refValue = putOffHistory(store, 'to be erased')
    const rec = record({ type: 'person', mark: M1, fields: { note: refValue } })
    const hashBefore = hashRecord(rec)

    const id = offHistoryId(refValue)!
    store.delete(id)

    // content is gone
    expect(resolveOffHistory(store, refValue)).toBeUndefined()
    expect(store.has(id)).toBe(false)
    // the record, and thus every commit that contains it, is byte-for-byte unchanged
    expect(hashRecord(rec)).toBe(hashBefore)
  })

  it('does not treat a normal blob as an off-history reference', () => {
    const normal = { kind: 'blob' as const, hash: 'sha256:abc' }
    expect(isOffHistoryRef(normal)).toBe(false)
    expect(offHistoryId(normal)).toBeUndefined()
  })
})
