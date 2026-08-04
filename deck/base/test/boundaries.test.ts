import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { hashRecord } from '@term/base/code/canon/hash'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { removeMatching } from '@term/base/code/erase/erase'
import { RevocationList, enforceRevocation } from '@term/base/code/erase/revocation'
import { applyChunks } from '@term/base/code/sync/chunk-sync'
import { MemoryObjectStore } from '@term/base/code/store/object-store'
import { chunkKey } from '@term/base/code/store/r2-chunk-store'
import { reachableChunksAsync, collectGarbageAsync } from '@term/base/code/gc/gc-async'
import { R2ChunkStore } from '@term/base/code/store/r2-chunk-store'
import { MemoryOffHistoryStore, offHistoryId } from '@term/base/code/offhistory/store'
import { partitionSensitive, resolveSensitive } from '@term/base/code/offhistory/sensitive'
import { RedactionVault, redactReversibly, unredact } from '@term/base/code/redact/reversible'
import { isRedacted } from '@term/base/code/redact/redact'

const A = '11111111-1111-4111-8111-111111111111'
const SECRET_MARK = '22222222-2222-4222-8222-222222222222'
const SECRET = 'SSN-123-45-6789'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

describe('distributed erasure: revocation', () => {
  it('records revoked content and refuses to re-admit it over sync', () => {
    const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore())
    const secret = record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } })
    const secretHash = hashRecord(secret)
    repo.commit('main', meta(1, 'c1'), datasetOf([secret]))

    const revocation = new RevocationList()
    const report = repo.eraseFromHistory(removeMatching(n => n.type === 'person'), { revocation })
    expect(report.revoked).toContain(secretHash)
    expect(revocation.has(secretHash)).toBe(true)

    // a hostile peer tries to push the erased chunk back: it is refused, not stored
    const target = new MemoryChunkStore()
    const stored = applyChunks([{ hash: secretHash, bytes: canonicalizeRecord(secret) }], target, revocation)
    expect(stored).toBe(0)
    expect(target.has(secretHash)).toBe(false)
  })

  it('enforces a revocation against a replica that already holds the content', () => {
    const store = new MemoryChunkStore()
    const secret = record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET) } })
    const h = store.put(canonicalizeRecord(secret))
    const revocation = new RevocationList([h])
    const report = enforceRevocation(store, revocation)
    expect(report.removed).toBe(1)
    expect(store.has(h)).toBe(false)
  })

  it('merges and round-trips revocation lists (grow-only set)', () => {
    const a = new RevocationList(['x', 'y'])
    const b = new RevocationList(['y', 'z'])
    a.merge(b)
    expect(a.hashes()).toEqual(['x', 'y', 'z'])
    const round = RevocationList.decode(a.encode())
    expect(round.hashes()).toEqual(['x', 'y', 'z'])
  })
})

describe('async mirror garbage collection', () => {
  it('computes the reachable set and sweeps an object store over the network', async () => {
    const chunks = new MemoryChunkStore()
    const repo = new Repository(chunks, new MemoryRefStore())
    repo.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('a') } })]))
    repo.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: A, fields: { term: text('b') } })]))

    // mirror every chunk into an object store, plus a stray
    const objects = new MemoryObjectStore()
    for (const h of chunks.keys()) {
      await objects.put(chunkKey(h), chunks.get(h)!)
    }
    await objects.put(chunkKey(`sha256:${'0'.repeat(64)}`), 'orphan')

    const head = repo.head('main')!
    // the async reachable set matches the sync one
    const asyncReachable = await reachableChunksAsync(new R2ChunkStore(objects), [head])
    expect(asyncReachable).toEqual(repo.reachableChunkHashes())

    const report = await collectGarbageAsync(objects, [head])
    expect(report.removed).toBe(1)
    expect(await objects.get(chunkKey(`sha256:${'0'.repeat(64)}`))).toBeUndefined()
    // reachable objects survive
    for (const h of repo.reachableChunkHashes()) {
      expect(await objects.get(chunkKey(h))).toBeDefined()
    }
  })
})

describe('sensitivity routing (sealed fields off-history)', () => {
  const role = roleBase([
    form('person', [
      property('ssn', { base: 'text' }, { constraints: [hold('seal')] }),
      property('name', { base: 'text' }),
    ]),
  ])

  it('moves sealed fields off-history and keeps only a reference in the record', () => {
    const off = new MemoryOffHistoryStore()
    const ds = datasetOf([
      record({ type: 'person', mark: SECRET_MARK, fields: { ssn: text(SECRET), name: text('Ann') } }),
    ])
    const { dataset, moved } = partitionSensitive(ds, role, off)
    expect(moved).toBe(1)

    const rec = dataset.get(SECRET_MARK)!
    // the record no longer contains the secret, only an off-history reference
    expect(rec.fields.get('ssn')!.kind).toBe('blob')
    expect(canonicalizeRecord(rec).includes(SECRET)).toBe(false)
    // non-sealed fields are untouched
    expect(rec.fields.get('name')).toEqual(text('Ann'))

    // it resolves back for reading
    expect(resolveSensitive(rec, role, off).fields.get('ssn')).toEqual(text(SECRET))

    // deleting the off-history content makes the sealed field read as null
    off.delete(offHistoryId(rec.fields.get('ssn')!)!)
    expect(resolveSensitive(rec, role, off).fields.get('ssn')).toEqual({ kind: 'null' })
  })
})

describe('reversible redaction', () => {
  it('redacts reversibly, restores within the window, and finalizes to permanent', () => {
    const vault = new RedactionVault()
    const ds = datasetOf([record({ type: 'word', mark: A, fields: { term: text('secret') } })])

    const { dataset, ticket } = redactReversibly(ds, A, { reason: 'mistake', by: 'ann', time: 1 }, vault)
    expect(ticket).toBeDefined()
    expect(isRedacted(dataset.get(A)!)).toBe(true)

    // reversible while the key lives
    expect(vault.reversible(ticket!)).toBe(true)
    const restored = unredact(dataset, ticket!, vault)
    expect(restored.get(A)!.fields.get('term')).toEqual(text('secret'))

    // finalize: the key is shredded, the redaction is now permanent
    vault.finalize(ticket!)
    expect(vault.reversible(ticket!)).toBe(false)
    expect(isRedacted(unredact(dataset, ticket!, vault).get(A)!)).toBe(true)
  })
})
