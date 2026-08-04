import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { createBundle, encodeBundle, decodeBundle, applyBundle } from '@term/base/code/transport/bundle'
import { packChunks, unpack, readFromPack } from '@term/base/code/store/pack'
import { shallowChunks, sparseRecords, ofTypes } from '@term/base/code/sync/partial'
import { MemoryRemoteRepo } from '@term/base/code/transport/session'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const meta = (t: number, m: string) => ({ author: 'a', time: t, message: m })

describe('bundle', () => {
  it('packages a slice and applies it to a fresh store', () => {
    const chunks = new MemoryChunkStore()
    const refs = new MemoryRefStore()
    const r = new Repository(chunks, refs)
    const c1 = r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    if (!c1.ok) return

    const bundle = decodeBundle(encodeBundle(createBundle(chunks, { 'branch/main': c1.commit })))

    // apply into a fresh repo
    const chunks2 = new MemoryChunkStore()
    const refs2 = new MemoryRefStore()
    const report = applyBundle(bundle, chunks2, refs2)
    expect(report.rejected).toEqual([])
    const r2 = new Repository(chunks2, refs2)
    expect(r2.checkoutBranch('main').get(M1)!.fields.get('term')).toEqual(text('a'))
  })

  it('rejects a tampered chunk', () => {
    const chunks = new MemoryChunkStore()
    const r = new Repository(chunks, new MemoryRefStore())
    const c1 = r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    if (!c1.ok) return
    const bundle = createBundle(chunks, { 'branch/main': c1.commit })
    const someHash = Object.keys(bundle.chunks)[0]!
    bundle.chunks[someHash] = 'tampered'
    const report = applyBundle(bundle, new MemoryChunkStore(), new MemoryRefStore())
    expect(report.rejected).toContain(someHash)
  })
})

describe('pack', () => {
  it('packs chunks into one blob and unpacks them back', () => {
    const chunks = new MemoryChunkStore()
    const h1 = chunks.put('alpha')
    const h2 = chunks.put('beta')
    const pack = packChunks(chunks, [h1, h2])
    expect(readFromPack(pack, h1)).toBe('alpha')
    expect(readFromPack(pack, h2)).toBe('beta')

    const target = new MemoryChunkStore()
    expect(unpack(pack, target)).toBe(2)
    expect(target.get(h1)).toBe('alpha')
  })
})

describe('partial replication', () => {
  it('takes a shallow snapshot without ancestry', () => {
    const chunks = new MemoryChunkStore()
    const r = new Repository(chunks, new MemoryRefStore())
    r.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const c2 = r.commit('main', meta(2, 'c2'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('b') } })]))
    if (!c2.ok) return
    const snap = shallowChunks(c2.commit, chunks)
    // the snapshot has the head commit but not its parent commit
    expect(snap.has(c2.commit)).toBe(true)
    expect(snap.has(r.readCommit(c2.commit).parents[0]!)).toBe(false)
  })

  it('takes a sparse subset by type', () => {
    const chunks = new MemoryChunkStore()
    const r = new Repository(chunks, new MemoryRefStore())
    const c1 = r.commit('main', meta(1, 'c1'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'sound', mark: M2, fields: { ipa: text('b') } }),
    ]))
    if (!c1.ok) return
    const subset = sparseRecords(c1.commit, chunks, ofTypes(['word']))
    expect([...subset.keys()]).toEqual([M1])
  })
})

describe('remote push and pull', () => {
  function makeRepo() {
    return new Repository(new MemoryChunkStore(), new MemoryRefStore())
  }

  it('pushes to a remote, transferring only missing chunks', async () => {
    const local = makeRepo()
    local.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const remote = new MemoryRemoteRepo(new MemoryChunkStore(), new MemoryRefStore())

    const res = await local.push(remote, 'main')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.transferred).toBeGreaterThan(0)

    // a second push with no new commits transfers nothing
    const again = await local.push(remote, 'main')
    expect(again).toEqual({ ok: true, status: 'up-to-date', transferred: 0 })
  })

  it('pulls a fast-forward from a remote', async () => {
    const server = makeRepo()
    server.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const remote = new MemoryRemoteRepo(
      (server as unknown as { chunks: MemoryChunkStore }).chunks,
      (server as unknown as { refs: MemoryRefStore }).refs,
    )

    const client = makeRepo()
    const res = await client.pull(remote, 'main')
    expect(res.ok).toBe(true)
    if (res.ok) expect(res.status).toBe('fast-forward')
    expect(client.checkoutBranch('main').get(M1)!.fields.get('term')).toEqual(text('a'))
  })

  it('rejects a diverged push and merges on pull', async () => {
    // shared history on the remote
    const serverChunks = new MemoryChunkStore()
    const serverRefs = new MemoryRefStore()
    const server = new Repository(serverChunks, serverRefs)
    server.commit('main', meta(1, 'c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const remote = new MemoryRemoteRepo(serverChunks, serverRefs)

    // client clones, then both diverge on different records
    const client = makeRepo()
    await client.pull(remote, 'main')
    client.commit('main', meta(2, 'client'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a') } }),
      record({ type: 'word', mark: M2, fields: { term: text('client') } }),
    ]))
    // server advances M1's gloss (disjoint field/record from the client's change)
    server.commit('main', meta(3, 'server'), datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('a'), gloss: text('server') } }),
    ]))

    // push is rejected because the remote diverged
    const push = await client.push(remote, 'main')
    expect(push.ok).toBe(false)

    // pull merges the two disjoint changes
    const pull = await client.pull(remote, 'main')
    expect(pull.ok).toBe(true)
    if (pull.ok) expect(pull.status).toBe('merged')
    const head = client.checkoutBranch('main')
    expect(head.get(M2)!.fields.get('term')).toEqual(text('client'))
    expect(head.get(M1)!.fields.get('gloss')).toEqual(text('server'))

    // now push succeeds (fast-forward from the merge)
    const push2 = await client.push(remote, 'main')
    expect(push2.ok).toBe(true)
  })
})
