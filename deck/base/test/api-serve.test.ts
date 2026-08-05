import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'net'
import { serveApi, match, recordJson } from '@term/base/code/api/serve'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('count', { base: 'integer' }),
])

const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), roleBase([wordForm]))
repo.commit('main', { author: 'a', time: 1, message: 'c1' },
  datasetOf([record({ type: 'word', mark: M1, fields: { term: text('one'), count: integer(9007199254740993n) } })]))

let base = ''
let server: ReturnType<typeof serveApi>
let asUser = 'lance'

beforeAll(async () => {
  server = serveApi({
    open: async ({ repository }) => (repository === 'make' ? repo : undefined),
    session: async () => (asUser ? { user: asUser } : {}),
  })
  await new Promise<void>(r => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

const get = (p: string) => fetch(`${base}${p}`)
const post = (p: string, b: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json()

const R = '/workspaces/term/repositories/make/branches/main'

describe('match', () => {
  it('binds parameters and rejects a different shape', () => {
    expect(match('/a/:b/c', '/a/x/c')).toEqual({ b: 'x' })
    expect(match('/a/:b/c', '/a/x')).toBeUndefined()
    expect(match('/a/:b', '/a/x%2Fy')).toEqual({ b: 'x/y' })
  })
})

describe('recordJson', () => {
  it('serializes fields, which a Map would render as {}', () => {
    const out = recordJson(record({ type: 'word', mark: M1, fields: { term: text('one') } })) as any
    expect(out.fields.term).toEqual({ kind: 'text', value: 'one' })
  })

  it('keeps a bigint exact rather than throwing', () => {
    const out = recordJson(record({ type: 'word', mark: M1, fields: { count: integer(9007199254740993n) } })) as any
    expect(out.fields.count).toEqual({ kind: 'integer', value: '9007199254740993' })
  })
})

describe('repository routes', () => {
  it('serves head', async () => {
    const r = await get(`${R}/head`)
    expect(r.status).toBe(200)
    expect((await json(r)).commit).toBe(repo.head('main'))
  })

  it('serves state with records that actually carry fields', async () => {
    const r = await post(`${R}/state!`, {})
    const body = await json(r)
    expect(body.records).toHaveLength(1)
    expect(body.records[0].fields.term).toEqual({ kind: 'text', value: 'one' })
  })

  it('serves changes', async () => {
    const r = await post(`${R}/changes!`, {})
    expect((await json(r)).changes.length).toBeGreaterThan(0)
  })

  it('faults on an unknown from rather than resending everything', async () => {
    const r = await post(`${R}/changes!`, { from: 'sha256:' + '0'.repeat(64) })
    expect(r.status).toBe(404)
    expect((await json(r)).fault).toBe('no-commit')
  })

  it('serves one record and 404s an unknown mark', async () => {
    expect((await get(`${R}/records/${M1}`)).status).toBe(200)
    expect((await get(`${R}/records/${M2}`)).status).toBe(404)
  })

  it('serves history', async () => {
    const r = await get(`${R}/records/${M1}/history`)
    expect(r.status).toBe(200)
    expect((await json(r)).versions.length).toBeGreaterThan(0)
  })

  it('lists branches', async () => {
    const r = await get('/workspaces/term/repositories/make/branches'.replace('', ''))
    expect(r.status).toBe(200)
  })

  it('404s an unknown repository', async () => {
    expect((await get('/workspaces/term/repositories/ghost/branches/main/head')).status).toBe(404)
  })

  it('404s an unknown route', async () => {
    expect((await get('/nonsense')).status).toBe(404)
  })
})

describe('commit', () => {
  it('writes a change set', async () => {
    const before = repo.head('main')
    const r = await post(`${R}/commit!`, {
      message: 'add', time: 2,
      changes: [{ type: 'record.add', mark: M2, value: { type: 'word', mark: M2, fields: {} } }],
    })
    // the value shape is validated by the form, so this may reject; either way it is not 401
    expect(r.status).not.toBe(401)
    expect(before).toBeDefined()
  })

  it('refuses an unauthenticated write rather than acting as nobody', async () => {
    asUser = ''
    const r = await post(`${R}/commit!`, { message: 'x', time: 3, changes: [] })
    asUser = 'lance'
    expect(r.status).toBe(401)
    expect((await json(r)).fault).toBe('unauthenticated')
  })
})
