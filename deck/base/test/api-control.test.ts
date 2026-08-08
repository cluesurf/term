import { describe, it, expect } from 'vitest'
import {
  createWorkspace, listWorkspaces, readWorkspace,
  createRepository, listRepositories, resolve,
  addMember, removeMember, listMembers, mayAct,
  setDatabase, getDatabase, registerContract, listContracts,
  checkSlug, controlStatus, CONTROL_ROUTES,
  type ControlStore, type Workspace, type RepositoryRow, type Member,
  type ProjectionDatabase,
} from '@term/base/code/api/control'
import type { Contract } from '@term/base/code/project/contract'

// An in-memory binding of the seam, which is the point of the seam existing.
function store(): ControlStore {
  const workspaces = new Map<string, Workspace>()
  const repositories = new Map<string, RepositoryRow>()
  const members: Array<Member> = []
  const databases = new Map<string, ProjectionDatabase>()
  const contracts: Array<Contract> = []
  const key = (m: { resourceForm: string; resource: string }) =>
    `${m.resourceForm} ${m.resource}`

  return {
    async workspaces() { return [...workspaces.values()] },
    async workspaceBySlug(slug) { return [...workspaces.values()].find(w => w.slug === slug) },
    async putWorkspace(w) { workspaces.set(w.id, w) },
    async repositories(workspace) { return [...repositories.values()].filter(r => r.workspace === workspace) },
    async repositoryBySlug({ workspace, slug }) {
      return [...repositories.values()].find(r => r.workspace === workspace && r.slug === slug)
    },
    async putRepository(r) { repositories.set(r.id, r) },
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

const make = async (s: ControlStore) =>
  createWorkspace(s, { slug: 'term', name: 'Term', owner: 'lance' })

// ids are server-generated now, so tests resolve them from the store by slug
const wid = async (s: ControlStore): Promise<string> =>
  (await s.workspaceBySlug('term'))!.id
const rid = async (s: ControlStore): Promise<string> => {
  const w = await s.workspaceBySlug('term')
  return (await s.repositoryBySlug({ workspace: w!.id, slug: 'make' }))!.id
}

describe('checkSlug', () => {
  it('accepts a normal slug', () => expect(checkSlug('term-surf')).toBeUndefined())
  it('rejects uppercase and underscores', () => {
    expect(checkSlug('Term')).toMatchObject({ fault: 'bad-slug' })
    expect(checkSlug('a_b')).toMatchObject({ fault: 'bad-slug' })
  })
  it('rejects leading, trailing and doubled hyphens', () => {
    for (const s of ['-a', 'a-', 'a--b']) expect(checkSlug(s)).toMatchObject({ fault: 'bad-slug' })
  })
  it('rejects a reserved name that would collide with a route', () => {
    expect(checkSlug('settings')).toMatchObject({ fault: 'bad-slug', why: 'reserved' })
  })
})

describe('workspaces', () => {
  it('creates one and makes the creator a member', async () => {
    const s = store()
    const r = await make(s)
    expect(r.ok && r.value.slug).toBe('term')
    expect(await mayAct(s, 'lance', 'workspace', await wid(s))).toBe(true)
  })

  it('refuses a duplicate slug', async () => {
    const s = store()
    await make(s)
    const again = await createWorkspace(s, { slug: 'term', name: 'Other', owner: 'x' })
    expect(again).toMatchObject({ ok: false, fault: 'taken' })
  })

  it('reads and lists', async () => {
    const s = store()
    await make(s)
    expect((await readWorkspace(s, 'term')).ok).toBe(true)
    expect((await readWorkspace(s, 'nope'))).toMatchObject({ ok: false, fault: 'not-found' })
    const list = await listWorkspaces(s)
    expect(list.ok && list.value).toHaveLength(1)
  })
})

describe('repositories', () => {
  const repo = (s: ControlStore, user = 'lance') =>
    createRepository(s, { workspaceSlug: 'term', slug: 'make', name: 'Make', user })

  it('creates one inside a workspace', async () => {
    const s = store(); await make(s)
    const r = await repo(s)
    expect(r.ok && r.value.slug).toBe('make')
  })

  it('refuses a non-member, as forbidden rather than not-found', async () => {
    const s = store(); await make(s)
    const r = await repo(s, 'stranger')
    expect(r).toMatchObject({ ok: false, fault: 'forbidden' })
  })

  it('refuses a duplicate slug within the workspace', async () => {
    const s = store(); await make(s); await repo(s)
    const again = await createRepository(s, { workspaceSlug: 'term', slug: 'make', name: 'X', user: 'lance' })
    expect(again).toMatchObject({ ok: false, fault: 'taken' })
  })

  it('resolves @workspace/repository', async () => {
    const s = store(); await make(s); await repo(s)
    const r = await resolve(s, { workspace: 'term', repository: 'make' })
    expect(r.ok && r.value.repository.id).toBe(await rid(s))
    expect(await resolve(s, { workspace: 'term', repository: 'ghost' }))
      .toMatchObject({ ok: false, what: 'repository' })
  })

  it('lists a workspace that exists and faults on one that does not', async () => {
    const s = store(); await make(s); await repo(s)
    const list = await listRepositories(s, 'term')
    expect(list.ok && list.value).toHaveLength(1)
    expect(await listRepositories(s, 'nope')).toMatchObject({ ok: false })
  })
})

describe('membership', () => {
  it('adds a member when the actor is one', async () => {
    const s = store(); await make(s)
    const r = await addMember(s, { user: 'ada', resourceForm: 'workspace', resource: await wid(s), role: 'writer', by: 'lance' })
    expect(r.ok).toBe(true)
    expect(await mayAct(s, 'ada', 'workspace', await wid(s))).toBe(true)
  })

  it('refuses a stranger adding members', async () => {
    const s = store(); await make(s)
    expect(await addMember(s, { user: 'x', resourceForm: 'workspace', resource: await wid(s), role: 'writer', by: 'stranger' }))
      .toMatchObject({ ok: false, fault: 'forbidden' })
  })

  it('refuses to remove the last member, which would orphan the resource', async () => {
    const s = store(); await make(s)
    const r = await removeMember(s, { user: 'lance', resourceForm: 'workspace', resource: await wid(s), by: 'lance' })
    expect(r).toMatchObject({ ok: false, fault: 'forbidden' })
    expect(await mayAct(s, 'lance', 'workspace', await wid(s))).toBe(true)
  })

  it('removes one when others remain', async () => {
    const s = store(); await make(s)
    await addMember(s, { user: 'ada', resourceForm: 'workspace', resource: await wid(s), role: 'writer', by: 'lance' })
    const r = await removeMember(s, { user: 'ada', resourceForm: 'workspace', resource: await wid(s), by: 'lance' })
    expect(r.ok).toBe(true)
    expect(await mayAct(s, 'ada', 'workspace', await wid(s))).toBe(false)
  })

  it('scopes to a repository without granting the workspace', async () => {
    const s = store(); await make(s)
    await createRepository(s, { workspaceSlug: 'term', slug: 'make', name: 'Make', user: 'lance' })
    await addMember(s, { user: 'ada', resourceForm: 'repository', resource: await rid(s), role: 'writer', by: 'lance' })
    expect(await mayAct(s, 'ada', 'repository', await rid(s))).toBe(true)
    expect(await mayAct(s, 'ada', 'workspace', await wid(s))).toBe(false)
  })
})

describe('projection database', () => {
  it('records and reads where a workspace projects', async () => {
    const s = store(); await make(s)
    const r = await setDatabase(s, { workspace: await wid(s), handle: 'shared-01', tier: 'shared', by: 'lance' })
    expect(r.ok).toBe(true)
    const got = await getDatabase(s, await wid(s))
    expect(got.ok && got.value?.handle).toBe('shared-01')
  })

  it('refuses a non-member', async () => {
    const s = store(); await make(s)
    expect(await setDatabase(s, { workspace: await wid(s), handle: 'x', tier: 'shared', by: 'stranger' }))
      .toMatchObject({ ok: false, fault: 'forbidden' })
  })
})

describe('contracts', () => {
  it('registers and lists', async () => {
    const s = store()
    await registerContract(s, { consumer: 'acme', reads: [{ form: 'word', property: 'term' }] })
    const list = await listContracts(s)
    expect(list.ok && list.value).toHaveLength(1)
  })
})

describe('controlStatus and routes', () => {
  it('separates conflict, unprocessable, forbidden and missing', () => {
    expect(controlStatus({ ok: true })).toBe(200)
    expect(controlStatus({ ok: false, fault: 'taken' } as never)).toBe(409)
    expect(controlStatus({ ok: false, fault: 'bad-slug' } as never)).toBe(422)
    expect(controlStatus({ ok: false, fault: 'forbidden' } as never)).toBe(403)
    expect(controlStatus({ ok: false, fault: 'not-found' } as never)).toBe(404)
  })

  it('follows the platform path conventions', () => {
    for (const route of CONTROL_ROUTES) {
      expect(route.path).not.toContain('/api/')
      if (route.method === 'POST') expect(route.path).toMatch(/!$/)
    }
  })
})
