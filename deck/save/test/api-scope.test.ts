import { describe, it, expect } from 'vitest'
import {
  createWorkspace,
  createRepository,
  type ControlStore,
  type Workspace,
  type RepositoryRow,
  type Member,
  type ProjectionDatabase,
} from '@cluesurf/save/api/control'
import type { Contract } from '@cluesurf/save/project/contract'
import { registerForm } from '@cluesurf/save/api/form'
import type { FormStore, FormVersion } from '@cluesurf/save/api/form'
import {
  declarationsAgainstRepository,
  declarationsAgainstSpace,
  declaredOnChain,
  repositoryForms,
  spaceForms,
} from '@cluesurf/save/api/scope'
import type { Property } from '@cluesurf/save/form/form'

// The same in-memory binding api-control.test.ts uses.
function control(): ControlStore {
  const workspaces = new Map<string, Workspace>()
  const repositories = new Map<string, RepositoryRow>()
  const members: Array<Member> = []
  const databases = new Map<string, ProjectionDatabase>()
  const contracts: Array<Contract> = []
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
    async repositories(workspace) { return [...repositories.values()].filter(r => r.workspace === workspace) },
    async repositoryBySlug({ workspace, resource, slug }) {
      return [...repositories.values()].find(
        r => r.workspace === workspace && r.resource === resource && r.slug === slug,
      )
    },
    async putRepository(r) { repositories.set(r.id, r) },
    async workspaceOfRepository(id) { return repositories.get(id)?.workspace },
    async members(input) { return members.filter(m => key(m) === key(input)) },
    async putMember(m) { members.push(m) },
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

function formStore(): FormStore {
  const rows: Array<FormVersion> = []

  return {
    async forms(repository) { return rows.filter(row => row.repository === repository) },
    async versions(input) {
      return rows
        .filter(row => row.repository === input.repository && row.name === input.name)
        .sort((a, b) => b.version - a.version)
    },
    async putForm(form) { rows.push(form) },
  }
}

const prop = (name: string): Property => ({ name, like: { base: 'text' }, constraints: [] })

/** host > product > customer, with one repository under the customer. */
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
  const repository = await createRepository(s, {
    workspace: customer.value.id, slug: 'tune', name: 'Tune', user: 'alice',
  })
  if (!repository.ok) throw new Error(repository.fault)
  return { host: host.value, product: product.value, customer: customer.value, repository: repository.value }
}

async function declare(store: FormStore, key: string, name: string, properties: Array<Property>) {
  const made = await registerForm(store, { repository: key, name, properties, contracts: [], time: 1 })
  if (!made.ok) throw new Error(made.fault)
  return made.value.form
}

describe('forms in scope', () => {
  it('a repository sees its own forms, then the chain nearest first, first declaration winning', async () => {
    const s = control()
    const stores = { repositories: formStore(), spaces: formStore() }
    const { host, product, customer, repository } = await tree(s)

    await declare(stores.spaces, host.id, 'page', [prop('title')])
    await declare(stores.spaces, product.id, 'language', [prop('name')])
    await declare(stores.spaces, product.id, 'language', [prop('name'), prop('slug')])
    await declare(stores.repositories, repository.id, 'glyph', [prop('shape')])

    const seen = await repositoryForms({ control: s, stores, repository: repository.id })

    expect(seen.map(one => [one.name, one.version, one.declared.form])).toEqual([
      ['glyph', 1, 'repository'],
      ['language', 2, 'space'],
      ['page', 1, 'space'],
    ])
    expect(seen[1]?.declared).toEqual({ form: 'space', workspace: product.id, path: ['cluesurf', 'wordsurf'] })

    const atCustomer = await spaceForms({ control: s, stores, workspace: customer.id })
    expect(atCustomer.map(one => one.name)).toEqual(['language', 'page'])
    expect(await declaredOnChain({ control: s, stores, workspace: customer.id, name: 'language' })).toMatchObject({ form: 'space', workspace: product.id })
    expect(await declaredOnChain({ control: s, stores, workspace: customer.id, name: 'glyph' })).toBeUndefined()
  })

  it('a space may not declare a name an ancestor, a descendant, or a repository beneath declares', async () => {
    const s = control()
    const stores = { repositories: formStore(), spaces: formStore() }
    const { host, product, customer, repository } = await tree(s)

    await declare(stores.spaces, host.id, 'page', [prop('title')])
    await declare(stores.spaces, customer.id, 'glyph-set', [prop('glyphs')])
    await declare(stores.repositories, repository.id, 'entry', [prop('headword')])

    const above = await declarationsAgainstSpace({ control: s, stores, workspace: product.id, name: 'page' })
    expect(above).toEqual([{ form: 'space', workspace: host.id, path: ['cluesurf'] }])

    const below = await declarationsAgainstSpace({ control: s, stores, workspace: product.id, name: 'glyph-set' })
    expect(below).toEqual([{ form: 'space', workspace: customer.id, path: ['cluesurf', 'wordsurf', 'alice'] }])

    const beneath = await declarationsAgainstSpace({ control: s, stores, workspace: product.id, name: 'entry' })
    expect(beneath).toEqual([{ form: 'repository', repository: repository.id }])

    expect(await declarationsAgainstSpace({ control: s, stores, workspace: product.id, name: 'language' })).toEqual([])
  })

  it('a repository may not redeclare a name a space above it declares', async () => {
    const s = control()
    const stores = { repositories: formStore(), spaces: formStore() }
    const { product, repository } = await tree(s)

    await declare(stores.spaces, product.id, 'language', [prop('name')])

    expect(
      await declarationsAgainstRepository({ control: s, stores, repository: repository.id, name: 'language' }),
    ).toEqual([{ form: 'space', workspace: product.id, path: ['cluesurf', 'wordsurf'] }])
    expect(
      await declarationsAgainstRepository({ control: s, stores, repository: repository.id, name: 'entry' }),
    ).toEqual([])
  })
})
