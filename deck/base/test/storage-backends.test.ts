import { describe, it, expect } from 'vitest'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { decodeRecord } from '@term/base/code/canon/decode'
import { record, text } from '@term/base/code/base/make'
import { MemoryObjectStore } from '@term/base/code/store/object-store'
import { R2ChunkStore, chunkKey } from '@term/base/code/store/r2-chunk-store'
import {
  CockroachRefStore,
  PostgresRefStore,
  MemorySqlClient,
  DEFAULT_REF_COLUMNS,
} from '@term/base/code/store/sql-ref-store'

const M1 = '11111111-1111-4111-8111-111111111111'

describe('R2ChunkStore', () => {
  it('stores and retrieves content by hash over a flat key namespace', async () => {
    const objects = new MemoryObjectStore()
    const store = new R2ChunkStore(objects)
    const bytes = canonicalizeRecord(record({ type: 'word', mark: M1, fields: { term: text('foo') } }))
    const hash = await store.put(bytes)

    expect(await store.has(hash)).toBe(true)
    expect(await store.get(hash)).toBe(bytes)
    // round-trips back to the record
    expect(decodeRecord((await store.get(hash))!).fields.get('term')).toEqual(text('foo'))
    // flat key layout: one object at the bucket root, no shard dirs
    const keys = await objects.list()
    expect(keys).toEqual([chunkKey(hash)])
    expect(keys[0]!.includes('/')).toBe(false)
  })

  it('is content-addressed and idempotent: the same bytes write once', async () => {
    const objects = new MemoryObjectStore()
    const store = new R2ChunkStore(objects)
    const h1 = await store.put('same-bytes')
    const h2 = await store.put('same-bytes')
    expect(h1).toBe(h2)
    expect((await objects.list()).length).toBe(1)
  })

  it('reports absence for unknown hashes', async () => {
    const store = new R2ChunkStore(new MemoryObjectStore())
    expect(await store.has('sha256:deadbeef')).toBe(false)
    expect(await store.get('sha256:deadbeef')).toBeUndefined()
  })
})

describe('CockroachRefStore', () => {
  it('creates the table and compare-and-swaps like a branch head', async () => {
    const store = new CockroachRefStore(new MemorySqlClient())
    await store.init()

    expect(await store.get('branch/main')).toBeUndefined()

    // create (expected absent) succeeds once
    expect(await store.compareAndSwap('branch/main', undefined, 'commit-a')).toBe(true)
    expect(await store.compareAndSwap('branch/main', undefined, 'commit-x')).toBe(false)
    expect(await store.get('branch/main')).toBe('commit-a')

    // update with the correct expected head succeeds
    expect(await store.compareAndSwap('branch/main', 'commit-a', 'commit-b')).toBe(true)
    // update with a stale expected head fails (someone advanced it)
    expect(await store.compareAndSwap('branch/main', 'commit-a', 'commit-c')).toBe(false)
    expect(await store.get('branch/main')).toBe('commit-b')
  })

  it('lists refs', async () => {
    const store = new CockroachRefStore(new MemorySqlClient())
    await store.init()
    await store.compareAndSwap('branch/main', undefined, 'a')
    await store.compareAndSwap('branch/dev', undefined, 'b')
    expect((await store.list()).sort()).toEqual(['branch/dev', 'branch/main'])
  })

  it('defaults JS field names to camelCase and DB columns to double-underscore', () => {
    expect(DEFAULT_REF_COLUMNS.creationTimestamp).toBe('creation__timestamp')
    expect(DEFAULT_REF_COLUMNS.mutationTimestamp).toBe('mutation__timestamp')
    const store = new CockroachRefStore(new MemorySqlClient())
    // the emitted DDL uses the database column names
    expect(store.ddl()).toContain('"creation__timestamp" TIMESTAMPTZ')
    expect(store.ddl()).toContain('"ref"')
  })

  it('honors configurable table and column names', async () => {
    const store = new PostgresRefStore(new MemorySqlClient(), {
      table: 'base_ref',
      columns: {
        name: 'ref_name',
        hash: 'commit_hash',
        creationTimestamp: 'created_at',
        mutationTimestamp: 'updated_at',
      },
    })
    // the schema reflects the overrides
    expect(store.ddl()).toContain('"base_ref"')
    expect(store.ddl()).toContain('"commit_hash" TEXT NOT NULL')
    expect(store.ddl()).toContain('"created_at" TIMESTAMPTZ')
    expect(store.dialect).toBe('postgres')
    // and it still works end to end regardless of the column names
    await store.init()
    expect(await store.compareAndSwap('branch/main', undefined, 'c1')).toBe(true)
    expect(await store.compareAndSwap('branch/main', 'c1', 'c2')).toBe(true)
    expect(await store.compareAndSwap('branch/main', 'c1', 'c3')).toBe(false)
    expect(await store.get('branch/main')).toBe('c2')
  })
})
