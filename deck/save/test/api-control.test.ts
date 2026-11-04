import { describe, it, expect } from 'vitest'
import {
  createWorkspace, listWorkspaces, readWorkspace, listChildren,
  renameWorkspace, moveWorkspace, retireWorkspace, resolveWorkspace,
  chainOf, subtreeOf, effectiveVisibility,
  createRepository, listRepositories, resolve,
  addMember, removeMember, listMembers, mayAct,
  setDatabase, getDatabase, registerContract, listContracts,
  checkSlug, controlStatus, CONTROL_ROUTES,
  type ControlStore, type Workspace, type RepositoryRow, type Member,
  type ProjectionDatabase,
} from '@cluesurf/save/api/control'
import type { Contract } from '@cluesurf/save/project/contract'

// An in-memory binding of the seam, which is the point of the seam existing.
function store(): ControlStore {
  const workspaces = new Map<string, Workspace>()
  const repositories = new Map<string, RepositoryRow>()
  const members: Array<Member> = []
  const databases = new Map<string, ProjectionDatabase>()
  const contracts: Array<Contract> = []
  const former = new Map<string, string>()
  const key = (m: { resourceForm: string; resource: string }) =>
    `${m.resourceForm} ${m.resource}`

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
      return [...repositories.values()].find(
        r => r.workspace === workspace && r.resource === resource && r.slug === slug,
      )
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

const make = async (s: ControlStore) =>
  createWorkspace(s, { slug: 'term', name: 'Term', owner: 'lance' })

// ids are server-generated now, so tests resolve them from the store by slug
const wid = async (s: ControlStore): Promise<string> =>
  (await s.workspaceBySlug('term'))!.id
const rid = async (s: ControlStore): Promise<string> => {
  const w = await s.workspaceBySlug('term')
  return (await s.repositoryBySlug({ workspace: w!.id, slug: 'make' }))!.id
}

/** The tree the design is written for: a host, a product beneath it, a customer beneath that. */
async function tree(s: ControlStore) {
  const host = await createWorkspace(s, { slug: 'cluesurf', name: 'ClueSurf', owner: 'ops' })
  if (!host.ok) throw new Error(host.fault)
  const product = await createWorkspace(s, {
    slug: 'wordsurf', name: 'word.surf', owner: 'ops', parent: host.value.id, allowsChildren: true,
  })
  if (!product.ok) throw new Error(product.fault)
  const customer = await createWorkspace(s, {
    slug: 'alice', name: 'Alice', owner: 'alice', parent: product.value.id, by: 'ops',
  })
  if (!customer.ok) throw new Error(customer.fault)
  return { host: host.value, product: product.value, customer: customer.value }
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
    expect(checkSlug('resources')).toMatchObject({ fault: 'bad-slug', why: 'reserved' })
  })
  it('caps a slug at a DNS label', () => {
    expect(checkSlug('a'.repeat(63))).toBeUndefined()
    expect(checkSlug('a'.repeat(64))).toMatchObject({ fault: 'bad-slug' })
  })
})

describe('workspaces', () => {
  it('creates one and makes the creator a member', async () => {
    const s = store()
    const r = await make(s)
    expect(r.ok && r.value.slug).toBe('term')
    expect(r.ok && r.value.path).toEqual(['term'])
    expect(r.ok && r.value.depth).toBe(1)
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
    expect((await readWorkspace(s, ['term'])).ok).toBe(true)
    expect((await readWorkspace(s, 'nope'))).toMatchObject({ ok: false, fault: 'not-found' })
    const list = await listWorkspaces(s)
    expect(list.ok && list.value).toHaveLength(1)
  })
})

describe('nested workspaces', () => {
  it('materialises the path and depth down the chain', async () => {
    const s = store()
    const { customer } = await tree(s)
    expect(customer.path).toEqual(['cluesurf', 'wordsurf', 'alice'])
    expect(customer.depth).toBe(3)
    const chain = await chainOf(s, customer.id)
    expect(chain.map(w => w.slug)).toEqual(['cluesurf', 'wordsurf', 'alice'])
  })

  it('resolves a path one child at a time', async () => {
    const s = store()
    const { customer } = await tree(s)
    const found = await resolveWorkspace(s, ['cluesurf', 'wordsurf', 'alice'])
    expect(found.ok && found.value.workspace.id).toBe(customer.id)
    expect(await resolveWorkspace(s, ['cluesurf', 'alice'])).toMatchObject({ ok: false, fault: 'not-found' })
    expect(await resolveWorkspace(s, ['alice'])).toMatchObject({ ok: false })
  })

  it('lists children', async () => {
    const s = store()
    await tree(s)
    const kids = await listChildren(s, ['cluesurf', 'wordsurf'])
    expect(kids.ok && kids.value.map(w => w.slug)).toEqual(['alice'])
  })

  it('lets a sibling reuse a slug that exists elsewhere, since the address is the path', async () => {
    const s = store()
    const { host, product } = await tree(s)
    const text = await createWorkspace(s, { slug: 'textsurf', name: 'text.surf', owner: 'ops', parent: host.id, allowsChildren: true })
    expect(text.ok).toBe(true)
    const again = await createWorkspace(s, { slug: 'alice', name: 'Alice', owner: 'alice', parent: text.ok ? text.value.id : '', by: 'ops' })
    expect(again.ok && again.value.path).toEqual(['cluesurf', 'textsurf', 'alice'])
    // and a sibling under the same parent is refused
    expect(await createWorkspace(s, { slug: 'alice', name: 'X', owner: 'x', parent: product.id, by: 'ops' }))
      .toMatchObject({ ok: false, fault: 'taken' })
  })

  it('refuses a slug equal to an ancestor slug, which is what lets a site resolve @x', async () => {
    const s = store()
    const { product } = await tree(s)
    expect(await createWorkspace(s, { slug: 'cluesurf', name: 'X', owner: 'ops', parent: product.id }))
      .toMatchObject({ ok: false, fault: 'refused' })
    expect(await createWorkspace(s, { slug: 'wordsurf', name: 'X', owner: 'ops', parent: product.id }))
      .toMatchObject({ ok: false, fault: 'refused' })
  })

  it('refuses a child beneath a workspace that takes none', async () => {
    const s = store()
    const { customer } = await tree(s)
    expect(customer.allowsChildren).toBe(false)
    expect(await createWorkspace(s, { slug: 'team', name: 'Team', owner: 'alice', parent: customer.id }))
      .toMatchObject({ ok: false, fault: 'refused' })
  })

  it('refuses a stranger creating beneath a workspace', async () => {
    const s = store()
    const { product } = await tree(s)
    expect(await createWorkspace(s, { slug: 'mallory', name: 'M', owner: 'mallory', parent: product.id }))
      .toMatchObject({ ok: false, fault: 'forbidden' })
  })

  it('caps the depth', async () => {
    const s = store()
    let parent: string | undefined
    for (let i = 0; i < 8; i += 1) {
      const made = await createWorkspace(s, { slug: `s${i}`, name: `S${i}`, owner: 'ops', parent, allowsChildren: true })
      expect(made.ok).toBe(true)
      parent = made.ok ? made.value.id : undefined
    }
    expect(await createWorkspace(s, { slug: 's8', name: 'S8', owner: 'ops', parent }))
      .toMatchObject({ ok: false, fault: 'refused' })
  })

  it('renames and re-paths every descendant, remembering the old path', async () => {
    const s = store()
    const { product, customer } = await tree(s)
    const renamed = await renameWorkspace(s, { id: product.id, slug: 'words', by: 'ops' })
    expect(renamed.ok && renamed.value.path).toEqual(['cluesurf', 'words'])
    expect((await s.workspaceById(customer.id))!.path).toEqual(['cluesurf', 'words', 'alice'])
    expect(await s.workspaceAtFormerPath!(['cluesurf', 'wordsurf'])).toBe(product.id)
    expect(await s.workspaceAtFormerPath!(['cluesurf', 'wordsurf', 'alice'])).toBe(customer.id)
    // the rename obeys the ancestor rule and the descendant rule
    expect(await renameWorkspace(s, { id: product.id, slug: 'cluesurf', by: 'ops' })).toMatchObject({ ok: false, fault: 'refused' })
    expect(await renameWorkspace(s, { id: product.id, slug: 'alice', by: 'ops' })).toMatchObject({ ok: false, fault: 'refused' })
  })

  it('moves a subtree and refuses a destination inside it', async () => {
    const s = store()
    const { host, product, customer } = await tree(s)
    const text = await createWorkspace(s, { slug: 'textsurf', name: 'text.surf', owner: 'ops', parent: host.id, allowsChildren: true })
    const textId = text.ok ? text.value.id : ''
    const moved = await moveWorkspace(s, { id: customer.id, parent: textId, by: 'ops' })
    expect(moved.ok && moved.value.path).toEqual(['cluesurf', 'textsurf', 'alice'])
    expect(await moveWorkspace(s, { id: host.id, parent: product.id, by: 'ops' })).toMatchObject({ ok: false, fault: 'refused' })
    expect(await moveWorkspace(s, { id: host.id, parent: host.id, by: 'ops' })).toMatchObject({ ok: false, fault: 'refused' })
    // to the root
    const rooted = await moveWorkspace(s, { id: product.id, parent: undefined, by: 'ops' })
    expect(rooted.ok && rooted.value.path).toEqual(['wordsurf'])
    expect(rooted.ok && rooted.value.parent).toBeUndefined()
  })

  it('refuses a move the customer may not make, and one into a leaf', async () => {
    const s = store()
    const { product, customer } = await tree(s)
    expect(await moveWorkspace(s, { id: product.id, parent: undefined, by: 'alice' })).toMatchObject({ ok: false, fault: 'forbidden' })
    expect(await moveWorkspace(s, { id: product.id, parent: customer.id, by: 'ops' })).toMatchObject({ ok: false, fault: 'refused' })
  })

  it('retires a workspace and everything beneath it', async () => {
    const s = store()
    const { product, customer } = await tree(s)
    const done = await retireWorkspace(s, { id: product.id, by: 'ops', time: 5 })
    expect(done.ok && done.value.retired.sort()).toEqual([product.id, customer.id].sort())
    expect((await s.workspaceById(customer.id))!.retired).toBe(5)
    expect(await createWorkspace(s, { slug: 'bob', name: 'Bob', owner: 'bob', parent: product.id, by: 'ops' }))
      .toMatchObject({ ok: false, fault: 'refused' })
    expect(await subtreeOf(s, product.id)).toHaveLength(1)
  })

  it('takes visibility as the narrowest on the chain', () => {
    expect(effectiveVisibility([{ visibility: 'public' }, { visibility: 'public' }])).toBe('public')
    expect(effectiveVisibility([{ visibility: 'public' }, { visibility: 'private' }, {}])).toBe('private')
  })
})

describe('repositories', () => {
  const repo = (s: ControlStore, user = 'lance') =>
    createRepository(s, { workspaceSlug: 'term', slug: 'make', name: 'Make', user })

  it('creates one inside a workspace', async () => {
    const s = store(); await make(s)
    const r = await repo(s)
    expect(r.ok && r.value.slug).toBe('make')
    expect(r.ok && r.value.resource).toBeUndefined()
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

  it('lets one slug live under different resource keys, and none', async () => {
    const s = store(); await make(s); await repo(s)
    const keyed = await createRepository(s, { workspaceSlug: 'term', resource: 'language', slug: 'make', name: 'L', user: 'lance' })
    expect(keyed.ok && keyed.value.resource).toBe('language')
    const other = await createRepository(s, { workspaceSlug: 'term', resource: 'script', slug: 'make', name: 'S', user: 'lance' })
    expect(other.ok).toBe(true)
    expect(await createRepository(s, { workspaceSlug: 'term', resource: 'language', slug: 'make', name: 'L2', user: 'lance' }))
      .toMatchObject({ ok: false, fault: 'taken' })
    expect(await createRepository(s, { workspaceSlug: 'term', resource: 'Bad', slug: 'x', name: 'X', user: 'lance' }))
      .toMatchObject({ ok: false, fault: 'bad-slug' })
    const list = await listRepositories(s, 'term')
    expect(list.ok && list.value).toHaveLength(3)
  })

  it('resolves @workspace/repository', async () => {
    const s = store(); await make(s); await repo(s)
    const r = await resolve(s, { workspace: 'term', repository: 'make' })
    expect(r.ok && r.value.repository.id).toBe(await rid(s))
    expect(await resolve(s, { workspace: 'term', repository: 'ghost' }))
      .toMatchObject({ ok: false, what: 'repository' })
  })

  it('resolves a path with a resource key', async () => {
    const s = store()
    const { customer } = await tree(s)
    const made = await createRepository(s, { workspace: customer.id, resource: 'language', slug: 'tune', name: 'Tune', user: 'alice' })
    expect(made.ok).toBe(true)
    const r = await resolve(s, { workspace: ['cluesurf', 'wordsurf', 'alice'], resource: 'language', repository: 'tune' })
    expect(r.ok && r.value.repository.id).toBe(made.ok ? made.value.id : '')
    expect(r.ok && r.value.chain.map(w => w.slug)).toEqual(['cluesurf', 'wordsurf', 'alice'])
    // the keyless namespace does not see it
    expect(await resolve(s, { workspace: ['cluesurf', 'wordsurf', 'alice'], repository: 'tune' })).toMatchObject({ ok: false })
    // and a path create works too
    const byPath = await createRepository(s, { workspacePath: ['cluesurf', 'wordsurf'], slug: 'surf', name: 'Surf', user: 'ops' })
    expect(byPath.ok).toBe(true)
    const list = await listRepositories(s, ['cluesurf', 'wordsurf'])
    expect(list.ok && list.value.map(r => r.slug)).toEqual(['surf'])
  })

  it('lists a workspace that exists and faults on one that does not', async () => {
    const s = store(); await make(s); await repo(s)
    const list = await listRepositories(s, 'term')
    expect(list.ok && list.value).toHaveLength(1)
    expect(await listRepositories(s, 'nope')).toMatchObject({ ok: false })
  })

  it('refuses a repository in a retired workspace', async () => {
    const s = store(); await make(s)
    await retireWorkspace(s, { id: await wid(s), by: 'lance' })
    expect(await repo(s)).toMatchObject({ ok: false, fault: 'refused' })
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

  it('flows down the tree: a product admin acts on a customer, never the reverse', async () => {
    const s = store()
    const { host, product, customer } = await tree(s)
    expect(await mayAct(s, 'ops', 'workspace', customer.id)).toBe(true)
    expect(await mayAct(s, 'alice', 'workspace', product.id)).toBe(false)
    expect(await mayAct(s, 'alice', 'workspace', host.id)).toBe(false)
    const made = await createRepository(s, { workspace: customer.id, slug: 'x', name: 'X', user: 'alice' })
    const repository = made.ok ? made.value.id : ''
    expect(await mayAct(s, 'ops', 'repository', repository)).toBe(true)
    expect(await mayAct(s, 'alice', 'repository', repository)).toBe(true)
    expect(await mayAct(s, 'bob', 'repository', repository)).toBe(false)
    const members = await listMembers(s, { resourceForm: 'workspace', resource: customer.id })
    expect(members.ok && members.value.map(m => m.user)).toEqual(['alice'])
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
    expect(controlStatus({ ok: false, fault: 'refused' } as never)).toBe(422)
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

describe('atomic last-member removal', () => {
  it('routes through dropMemberIfNotLast when the store provides it', async () => {
    const members: Array<{ user: string; resourceForm: string; resource: string; role: string }> = []
    let atomicCalls = 0
    const s: ControlStore = {
      async workspaces() { return [] },
      async workspaceById() { return undefined },
      async workspaceChild() { return undefined },
      async children() { return [] },
      async workspaceBySlug() { return undefined },
      async putWorkspace() {},
      async repositories() { return [] },
      async repositoryBySlug() { return undefined },
      async putRepository() {},
      async members(input) {
        return members.filter(m => m.resourceForm === input.resourceForm && m.resource === input.resource) as never
      },
      async putMember(m) { members.push(m as never) },
      async dropMember() { throw new Error('should use the atomic path') },
      async dropMemberIfNotLast(input) {
        atomicCalls++
        const here = members.filter(m => m.resourceForm === input.resourceForm && m.resource === input.resource)
        if (here.length <= 1) return { dropped: false, wasLast: true }
        const at = members.findIndex(m => m.user === input.user && m.resourceForm === input.resourceForm && m.resource === input.resource)
        if (at >= 0) members.splice(at, 1)
        return { dropped: true, wasLast: false }
      },
      async database() { return undefined },
      async putDatabase() {},
      async contracts() { return [] },
      async putContract() {},
    }
    // owner + a second member so a removal is allowed
    members.push({ user: 'lance', resourceForm: 'workspace', resource: 'w', role: 'owner' })
    members.push({ user: 'ada', resourceForm: 'workspace', resource: 'w', role: 'writer' })

    const ok = await removeMember(s, { user: 'ada', resourceForm: 'workspace', resource: 'w', by: 'lance' })
    expect(ok.ok).toBe(true)
    expect(atomicCalls).toBe(1) // used the atomic conditional delete, not read-then-drop

    // removing the last one is declined by the same atomic call
    const last = await removeMember(s, { user: 'lance', resourceForm: 'workspace', resource: 'w', by: 'lance' })
    expect(last).toMatchObject({ ok: false, fault: 'forbidden' })
  })
})
