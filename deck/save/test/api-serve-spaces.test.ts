import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import type { AddressInfo } from 'net'
import { serveApi, locate } from '@cluesurf/save/api/serve'
import type { Located } from '@cluesurf/save/api/serve'
import type {
  ControlStore, Workspace, RepositoryRow, Member, ProjectionDatabase,
} from '@cluesurf/save/api/control'
import type { Contract } from '@cluesurf/save/project/contract'
import { record, text } from '@cluesurf/save/base/make'
import { datasetOf } from '@cluesurf/save/diff/change'
import { form, property, hold, roleBase } from '@cluesurf/save/form/form'
import { MemoryChunkStore } from '@cluesurf/save/store/chunk-store'
import { MemoryRefStore } from '@cluesurf/save/store/ref-store'
import { Repository } from '@cluesurf/save/repo/repo'

// The address grammar over the wire: nested spaces, a resource key, the flat form, and
// the control plane beneath a space.

function store(): ControlStore {
  const workspaces = new Map<string, Workspace>()
  const repositories = new Map<string, RepositoryRow>()
  const members: Array<Member> = []
  const databases = new Map<string, ProjectionDatabase>()
  const contracts: Array<Contract> = []
  const former = new Map<string, string>()
  const key = (m: { resourceForm: string; resource: string }) => `${m.resourceForm} ${m.resource}`

  return {
    async workspaces() { return [...workspaces.values()] },
    async workspaceById(id) { return workspaces.get(id) },
    async workspaceChild({ parent, slug }) {
      return [...workspaces.values()].find(w => w.parent === parent && w.slug === slug)
    },
    async children(parent) { return [...workspaces.values()].filter(w => w.parent === parent) },
    async workspaceBySlug(slug) { return [...workspaces.values()].find(w => w.slug === slug) },
    async putWorkspace(w) { workspaces.set(w.id, w) },
    async rememberPath({ workspace, path }) { former.set(path.join('/'), workspace) },
    async workspaceAtFormerPath(path) { return former.get(path.join('/')) },
    async repositories(workspace) { return [...repositories.values()].filter(r => r.workspace === workspace) },
    async repositoryBySlug({ workspace, resource, slug }) {
      return [...repositories.values()].find(r => r.workspace === workspace && r.resource === resource && r.slug === slug)
    },
    async putRepository(r) { repositories.set(r.id, r) },
    async workspaceOfRepository(id) { return repositories.get(id)?.workspace },
    async members(input) { return members.filter(m => key(m) === key(input)) },
    async putMember(m) {
      const at = members.findIndex(x => x.user === m.user && key(x) === key(m))
      if (at >= 0) members[at] = m; else members.push(m)
    },
    async dropMember(input) {
      const at = members.findIndex(x => x.user === input.user && key(x) === key(input))
      if (at >= 0) members.splice(at, 1)
    },
    async database(workspace) { return databases.get(workspace) },
    async putDatabase(d) { databases.set(d.workspace, d) },
    async contracts() { return [...contracts] },
    async putContract(c) { contracts.push(c) },
  }
}

const M1 = '11111111-1111-4111-8111-111111111111'
const wordForm = form('word', [property('term', { base: 'text' }, { constraints: [hold('need')] })])
const repo = new Repository(new MemoryChunkStore(), new MemoryRefStore(), roleBase([wordForm]))
repo.commit('main', { author: 'a', time: 1, message: 'c1' },
  datasetOf([record({ type: 'word', mark: M1, fields: { term: text('one') } })]))

const opened: Array<Located> = []
let base = ''
let server: ReturnType<typeof serveApi>
let asUser = 'ops'
const control = store()

beforeAll(async () => {
  server = serveApi({
    control,
    open: async input => {
      opened.push(input)
      // the chain names the repository: alice's `x`, or the product's language `tune`
      const chain = input.spaces?.join('/') ?? input.workspace
      if (chain === 'cluesurf/wordsurf/alice' && input.repository === 'x') return repo
      if (chain === 'cluesurf/wordsurf' && input.resource === 'language' && input.repository === 'tune') return repo
      if (chain === 'alice' && input.repository === 'x') return repo
      return undefined
    },
    session: async () => (asUser ? { user: asUser } : {}),
  })
  await new Promise<void>(r => server.listen(0, r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => server.close())

const get = (p: string) => fetch(`${base}${p}`, { redirect: 'manual' })
const post = (p: string, b: unknown) =>
  fetch(`${base}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const json = async (r: Response): Promise<any> => r.json()

describe('locate', () => {
  it('reads both spellings into one shape', () => {
    expect(locate('/@a/@b/repositories/x/branches/main/head')).toEqual({
      workspace: 'b', spaces: ['a', 'b'], repository: 'x', rest: ['branches', 'main', 'head'],
    })
    expect(locate('/@a/resources/language/repositories/t/branches')).toMatchObject({
      workspace: 'a', resource: 'language', repository: 't', rest: ['branches'],
    })
    expect(locate('/workspaces/a/repositories/x/branches/main/head')).toEqual({
      workspace: 'a', repository: 'x', rest: ['branches', 'main', 'head'],
    })
    expect(locate('/workspaces/a/repositories/create!')).toEqual({
      workspace: 'a', rest: ['repositories', 'create!'],
    })
    expect(locate('/@a/spaces/create!')).toMatchObject({ spaces: ['a'], rest: ['spaces', 'create!'] })
    expect(locate('/workspaces')).toBeUndefined()
    expect(locate('/workspaces/create!')).toBeUndefined()
    expect(locate('/contracts')).toBeUndefined()
    expect(locate('/@Bad')).toMatchObject({ fault: 'bad-address' })
  })
})

describe('the tree over the wire', () => {
  it('creates a root, a product beneath it, and a customer beneath that', async () => {
    const root = await post('/workspaces/create!', { slug: 'cluesurf', name: 'ClueSurf' })
    expect(root.status).toBe(200)
    const product = await post('/@cluesurf/spaces/create!', { slug: 'wordsurf', name: 'word.surf', allows_children: true })
    expect(product.status).toBe(200)
    expect((await json(product)).path).toEqual(['cluesurf', 'wordsurf'])
    const customer = await post('/@cluesurf/@wordsurf/spaces/create!', { slug: 'alice', name: 'Alice', owner: 'alice' })
    expect(customer.status).toBe(200)
    expect((await json(customer)).depth).toBe(3)
  })

  it('reads a space by path and lists its children', async () => {
    const r = await get('/@cluesurf/@wordsurf')
    expect(r.status).toBe(200)
    expect((await json(r)).slug).toBe('wordsurf')
    const kids = await get('/@cluesurf/@wordsurf/spaces')
    expect((await json(kids)).map((w: Workspace) => w.slug)).toEqual(['alice'])
    expect((await get('/@cluesurf/@alice')).status).toBe(404)
  })

  it('refuses the tree rules with 422', async () => {
    const same = await post('/@cluesurf/@wordsurf/spaces/create!', { slug: 'cluesurf', name: 'X' })
    expect(same.status).toBe(422)
    expect((await json(same)).fault).toBe('refused')
    const leaf = await post('/@cluesurf/@wordsurf/@alice/spaces/create!', { slug: 'team', name: 'T' })
    expect(leaf.status).toBe(422)
  })

  it('creates a keyless and a keyed repository, listed apart', async () => {
    asUser = 'alice'
    const made = await post('/@cluesurf/@wordsurf/@alice/repositories/create!', { slug: 'x', name: 'X' })
    expect(made.status).toBe(200)
    asUser = 'ops'
    const keyed = await post('/@cluesurf/@wordsurf/resources/language/repositories/create!', { slug: 'tune', name: 'Tune' })
    expect(keyed.status).toBe(200)
    expect((await json(keyed)).resource).toBe('language')
    const plain = await post('/@cluesurf/@wordsurf/repositories/create!', { slug: 'tune', name: 'Tune, keyless' })
    expect(plain.status).toBe(200)
    const listedKeyed = await get('/@cluesurf/@wordsurf/resources/language/repositories')
    expect((await json(listedKeyed)).map((r: RepositoryRow) => r.slug)).toEqual(['tune'])
    const listedPlain = await get('/@cluesurf/@wordsurf/repositories')
    expect((await json(listedPlain)).map((r: RepositoryRow) => r.resource)).toEqual([undefined])
  })

  it('serves a repository at its address, keyed or not, and the flat form still works', async () => {
    const nested = await get('/@cluesurf/@wordsurf/@alice/repositories/x/branches/main/head')
    expect(nested.status).toBe(200)
    expect((await json(nested)).commit).toBe(repo.head('main'))
    const keyed = await get('/@cluesurf/@wordsurf/resources/language/repositories/tune/branches')
    expect(keyed.status).toBe(200)
    const flat = await get('/workspaces/alice/repositories/x/branches/main/head')
    expect(flat.status).toBe(200)
    expect(opened.some(one => one.spaces?.join('/') === 'cluesurf/wordsurf/alice' && one.repository === 'x')).toBe(true)
    expect(opened.some(one => one.resource === 'language' && one.repository === 'tune')).toBe(true)
    expect((await get('/@cluesurf/@wordsurf/@alice/repositories/ghost/branches/main/head')).status).toBe(404)
    expect((await get('/@cluesurf/@wordsurf/repositories/tune/branches')).status).toBe(404)
  })

  it('renames with a redirect from the former path, and moves', async () => {
    const renamed = await post('/@cluesurf/@wordsurf/rename!', { slug: 'words' })
    expect(renamed.status).toBe(200)
    expect((await json(renamed)).path).toEqual(['cluesurf', 'words'])
    const old = await get('/@cluesurf/@wordsurf/@alice')
    expect(old.status).toBe(301)
    expect(old.headers.get('location')).toBe('/@cluesurf/@words/@alice')
    const back = await post('/@cluesurf/@words/rename!', { slug: 'wordsurf' })
    expect(back.status).toBe(200)
    const text = await post('/@cluesurf/spaces/create!', { slug: 'textsurf', name: 'text.surf', allows_children: true })
    expect(text.status).toBe(200)
    const moved = await post('/@cluesurf/@wordsurf/@alice/move!', { parent: '@cluesurf/@textsurf' })
    expect(moved.status).toBe(200)
    expect((await json(moved)).path).toEqual(['cluesurf', 'textsurf', 'alice'])
    const inward = await post('/@cluesurf/move!', { parent: '@cluesurf/@textsurf' })
    expect(inward.status).toBe(422)
    const home = await post('/@cluesurf/@textsurf/@alice/move!', { parent: '@cluesurf/@wordsurf' })
    expect(home.status).toBe(200)
  })

  it('manages members beneath a space, and a customer cannot touch the product', async () => {
    const added = await post('/@cluesurf/@wordsurf/members/mutate!', { user: 'bob', role: 'admin' })
    expect(added.status).toBe(200)
    const listed = await get('/@cluesurf/@wordsurf/members')
    expect((await json(listed)).map((m: Member) => m.user).sort()).toEqual(['bob', 'ops'])
    asUser = 'alice'
    const denied = await post('/@cluesurf/@wordsurf/members/mutate!', { user: 'alice', role: 'owner' })
    expect(denied.status).toBe(403)
    asUser = 'ops'
  })

  it('retires a subtree', async () => {
    const done = await post('/@cluesurf/@wordsurf/retire!', {})
    expect(done.status).toBe(200)
    expect((await json(done)).retired).toHaveLength(2)
    const refused = await post('/@cluesurf/@wordsurf/@alice/repositories/create!', { slug: 'y', name: 'Y' })
    expect(refused.status).toBe(422)
  })

  it('refuses an unauthenticated write', async () => {
    asUser = ''
    expect((await post('/@cluesurf/spaces/create!', { slug: 'z', name: 'Z' })).status).toBe(401)
    asUser = 'ops'
  })
})
