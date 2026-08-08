// The control-plane API: workspaces, repositories, membership, projections, contracts.
//
// These are the nine objects, not the object graph. A repository operation asks a
// Repository; a control-plane operation asks a database. So this module defines a STORE
// seam rather than importing a driver, exactly as the rest of the package defines
// ObjectStore and RefStore, and base.surf binds it to `move/v3` while a test binds it to
// a map.
//
// What lives here is only what cannot live in a repository: naming, because
// `@workspace/repository` has to be globally unique and that is a consensus question,
// plus who may act and where a projection lives.
//
// See note/library/base/design/model.md and
// note/library/base/design/control-plane-and-projections.md.

import { randomUUID } from 'crypto'
import type { Contract } from '@term/base/code/project/contract'

export type Workspace = {
  id: string
  slug: string
  name: string
  owner: string
}

export type RepositoryRow = {
  id: string
  workspace: string
  slug: string
  name: string
}

export type Member = {
  user: string
  // polymorphic by design: a membership scopes to a workspace OR a repository, so
  // granting someone one repository does not grant them the workspace
  resourceForm: 'workspace' | 'repository'
  resource: string
  role: string
}

// Where a workspace's projection lives. The routing table that makes per-workspace
// sharding a lookup rather than a rebalance.
export type ProjectionDatabase = {
  workspace: string
  // an opaque handle, never a connection string: the control plane records WHICH
  // database, and the operator resolves credentials. A URL here would put secrets in
  // every list response.
  handle: string
  tier: 'shared' | 'dedicated' | 'external'
}

/** The seam. Everything above is data; this is the only thing an implementation supplies. */
export type ControlStore = {
  workspaces(): Promise<Array<Workspace>>
  workspaceBySlug(slug: string): Promise<Workspace | undefined>
  putWorkspace(workspace: Workspace): Promise<void>

  repositories(workspace: string): Promise<Array<RepositoryRow>>
  repositoryBySlug(input: {
    workspace: string
    slug: string
  }): Promise<RepositoryRow | undefined>
  putRepository(repository: RepositoryRow): Promise<void>
  // Optional single-lookup: the workspace id that contains a repository. When present,
  // an authorization check resolves the container in one indexed read instead of
  // scanning every workspace's repositories (O(workspaces x repos) per check). A store
  // without it falls back to the scan.
  workspaceOfRepository?(repository: string): Promise<string | undefined>

  members(input: {
    resourceForm: Member['resourceForm']
    resource: string
  }): Promise<Array<Member>>
  putMember(member: Member): Promise<void>
  dropMember(input: {
    user: string
    resourceForm: Member['resourceForm']
    resource: string
  }): Promise<void>

  database(workspace: string): Promise<ProjectionDatabase | undefined>
  putDatabase(database: ProjectionDatabase): Promise<void>

  contracts(): Promise<Array<Contract>>
  putContract(contract: Contract): Promise<void>
}

export type ControlFault =
  | { fault: 'taken'; slug: string }
  | { fault: 'not-found'; what: string; slug: string }
  | { fault: 'bad-slug'; slug: string; why: string }
  | { fault: 'forbidden'; user: string; action: string }

export type Answer<T> = { ok: true; value: T } | ({ ok: false } & ControlFault)

const yes = <T>(value: T): Answer<T> => ({ ok: true, value })
const no = <T>(fault: ControlFault): Answer<T> => ({ ok: false, ...fault })

// A slug appears in `@workspace/repository`, in URLs, and in package names, so it has to
// survive all three. Lowercase and hyphenated, no leading or trailing hyphen, bounded so
// it cannot be used to make an unreadable or colliding name.
const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SLUG_MAX = 64

// Names that would collide with a route segment or read as a system resource.
const RESERVED = new Set([
  'new', 'edit', 'settings', 'admin', 'api', 'base', 'repositories',
  'workspaces', 'login', 'logout', 'sessions', 'levels',
])

export function checkSlug(slug: string): ControlFault | undefined {
  if (!SLUG.test(slug)) {
    return {
      fault: 'bad-slug',
      slug,
      why: 'lowercase letters, digits and single hyphens only',
    }
  }

  if (slug.length > SLUG_MAX) {
    return { fault: 'bad-slug', slug, why: `longer than ${SLUG_MAX}` }
  }

  if (RESERVED.has(slug)) {
    return { fault: 'bad-slug', slug, why: 'reserved' }
  }

  return undefined
}

/**
 * Create a workspace.
 *
 * Uniqueness is checked here AND has to be enforced by a unique constraint in the
 * database. This check gives a good error; the constraint is what makes it true, because
 * two simultaneous creates both see nothing and both proceed.
 */
export async function createWorkspace(
  store: ControlStore,
  input: { slug: string; name: string; owner: string },
): Promise<Answer<Workspace>> {
  const bad = checkSlug(input.slug)

  if (bad) {
    return no(bad)
  }

  if (await store.workspaceBySlug(input.slug)) {
    return no({ fault: 'taken', slug: input.slug })
  }

  const workspace: Workspace = {
    // the id is server-generated, never taken from the request: authorization is
    // keyed on it, so a client-chosen id could collide with an existing resource's
    // membership grants. The slug is the natural key the uniqueness check guards.
    id: randomUUID(),
    slug: input.slug,
    name: input.name,
    owner: input.owner,
  }

  await store.putWorkspace(workspace)
  // the creator is a member of what they created, or nobody can act on it
  await store.putMember({
    user: input.owner,
    resourceForm: 'workspace',
    resource: workspace.id,
    role: 'owner',
  })

  return yes(workspace)
}

export async function listWorkspaces(
  store: ControlStore,
): Promise<Answer<Array<Workspace>>> {
  return yes(await store.workspaces())
}

export async function readWorkspace(
  store: ControlStore,
  slug: string,
): Promise<Answer<Workspace>> {
  const workspace = await store.workspaceBySlug(slug)

  return workspace
    ? yes(workspace)
    : no({ fault: 'not-found', what: 'workspace', slug })
}

/**
 * Create a repository inside a workspace.
 *
 * Requires membership. An unauthorized create is `forbidden` rather than `not-found`,
 * because the workspace's existence is not a secret and pretending otherwise makes every
 * permission bug look like a missing row.
 */
export async function createRepository(
  store: ControlStore,
  input: {
    workspaceSlug: string
    slug: string
    name: string
    user: string
  },
): Promise<Answer<RepositoryRow>> {
  const bad = checkSlug(input.slug)

  if (bad) {
    return no(bad)
  }

  const workspace = await store.workspaceBySlug(input.workspaceSlug)

  if (!workspace) {
    return no({ fault: 'not-found', what: 'workspace', slug: input.workspaceSlug })
  }

  if (!(await mayAct(store, input.user, 'workspace', workspace.id))) {
    return no({ fault: 'forbidden', user: input.user, action: 'create repository' })
  }

  if (
    await store.repositoryBySlug({ workspace: workspace.id, slug: input.slug })
  ) {
    return no({ fault: 'taken', slug: input.slug })
  }

  const repository: RepositoryRow = {
    // server-generated id, never from the request (see createWorkspace)
    id: randomUUID(),
    workspace: workspace.id,
    slug: input.slug,
    name: input.name,
  }

  await store.putRepository(repository)

  return yes(repository)
}

export async function listRepositories(
  store: ControlStore,
  workspaceSlug: string,
): Promise<Answer<Array<RepositoryRow>>> {
  const workspace = await store.workspaceBySlug(workspaceSlug)

  if (!workspace) {
    return no({ fault: 'not-found', what: 'workspace', slug: workspaceSlug })
  }

  return yes(await store.repositories(workspace.id))
}

/** Resolve `@workspace/repository`, the name the whole platform is addressed by. */
export async function resolve(
  store: ControlStore,
  input: { workspace: string; repository: string },
): Promise<Answer<{ workspace: Workspace; repository: RepositoryRow }>> {
  const workspace = await store.workspaceBySlug(input.workspace)

  if (!workspace) {
    return no({ fault: 'not-found', what: 'workspace', slug: input.workspace })
  }

  const repository = await store.repositoryBySlug({
    workspace: workspace.id,
    slug: input.repository,
  })

  return repository
    ? yes({ workspace, repository })
    : no({ fault: 'not-found', what: 'repository', slug: input.repository })
}

/**
 * Whether a user may act on a resource.
 *
 * Membership on the resource itself, OR on the workspace that contains it. Without the
 * second clause a workspace owner cannot grant access to their own repository, which
 * makes the owner powerless over the thing they created. Repository membership stays
 * narrower than workspace membership: it grants that repository and nothing else.
 */
export async function mayAct(
  store: ControlStore,
  user: string,
  resourceForm: Member['resourceForm'],
  resource: string,
): Promise<boolean> {
  const direct = await store.members({ resourceForm, resource })

  if (direct.some(member => member.user === user)) {
    return true
  }

  if (resourceForm !== 'repository') {
    return false
  }

  // inherit from the containing workspace. Prefer the single indexed lookup when the
  // store provides it; otherwise fall back to scanning workspaces for the container.
  if (store.workspaceOfRepository) {
    const workspaceId = await store.workspaceOfRepository(resource)
    if (workspaceId === undefined) {
      return false
    }
    const above = await store.members({
      resourceForm: 'workspace',
      resource: workspaceId,
    })
    return above.some(member => member.user === user)
  }

  for (const workspace of await store.workspaces()) {
    const found = await store.repositories(workspace.id)

    if (found.some(repository => repository.id === resource)) {
      const above = await store.members({
        resourceForm: 'workspace',
        resource: workspace.id,
      })

      return above.some(member => member.user === user)
    }
  }

  return false
}

export async function addMember(
  store: ControlStore,
  input: Member & { by: string },
): Promise<Answer<Member>> {
  if (!(await mayAct(store, input.by, input.resourceForm, input.resource))) {
    return no({ fault: 'forbidden', user: input.by, action: 'add member' })
  }

  const member: Member = {
    user: input.user,
    resourceForm: input.resourceForm,
    resource: input.resource,
    role: input.role,
  }

  await store.putMember(member)

  return yes(member)
}

/**
 * Remove a member.
 *
 * Refuses to remove the last one. A resource with no members is unreachable by anyone,
 * and recovering it needs an operator reaching into the database, so the API declines to
 * create that state at all.
 */
export async function removeMember(
  store: ControlStore,
  input: {
    user: string
    resourceForm: Member['resourceForm']
    resource: string
    by: string
  },
): Promise<Answer<{ removed: string }>> {
  if (!(await mayAct(store, input.by, input.resourceForm, input.resource))) {
    return no({ fault: 'forbidden', user: input.by, action: 'remove member' })
  }

  const members = await store.members({
    resourceForm: input.resourceForm,
    resource: input.resource,
  })

  if (members.length <= 1) {
    return no({
      fault: 'forbidden',
      user: input.by,
      action: 'remove the last member',
    })
  }

  await store.dropMember({
    user: input.user,
    resourceForm: input.resourceForm,
    resource: input.resource,
  })

  return yes({ removed: input.user })
}

export async function listMembers(
  store: ControlStore,
  input: { resourceForm: Member['resourceForm']; resource: string },
): Promise<Answer<Array<Member>>> {
  return yes(await store.members(input))
}

/** Point a workspace's projection at a database, or move it to another. */
export async function setDatabase(
  store: ControlStore,
  input: ProjectionDatabase & { by: string },
): Promise<Answer<ProjectionDatabase>> {
  if (!(await mayAct(store, input.by, 'workspace', input.workspace))) {
    return no({ fault: 'forbidden', user: input.by, action: 'set database' })
  }

  const database: ProjectionDatabase = {
    workspace: input.workspace,
    handle: input.handle,
    tier: input.tier,
  }

  await store.putDatabase(database)

  return yes(database)
}

export async function getDatabase(
  store: ControlStore,
  workspace: string,
): Promise<Answer<ProjectionDatabase | undefined>> {
  return yes(await store.database(workspace))
}

/**
 * Register what a consumer reads, so a restructuring can be checked against it.
 *
 * Registration is the whole mechanism. An unregistered consumer cannot be protected and
 * cannot be warned, which is worth saying out loud rather than leaving as an implication.
 */
export async function registerContract(
  store: ControlStore,
  contract: Contract,
): Promise<Answer<Contract>> {
  await store.putContract(contract)

  return yes(contract)
}

export async function listContracts(
  store: ControlStore,
): Promise<Answer<Array<Contract>>> {
  return yes(await store.contracts())
}

export const CONTROL_ROUTES = [
  { method: 'GET', path: '/workspaces' },
  { method: 'POST', path: '/workspaces/create!' },
  { method: 'GET', path: '/workspaces/:workspace' },
  { method: 'GET', path: '/workspaces/:workspace/repositories' },
  { method: 'POST', path: '/workspaces/:workspace/repositories/create!' },
  { method: 'GET', path: '/workspaces/:workspace/members' },
  { method: 'POST', path: '/workspaces/:workspace/members/mutate!' },
  { method: 'GET', path: '/workspaces/:workspace/database' },
  { method: 'POST', path: '/workspaces/:workspace/database/mutate!' },
  { method: 'GET', path: '/contracts' },
  { method: 'POST', path: '/contracts/register!' },
] as const

/** The HTTP status a control fault maps to. */
export function controlStatus(
  answer: { ok: boolean } & Partial<ControlFault>,
): number {
  if (answer.ok) {
    return 200
  }

  switch (answer.fault) {
    case 'taken':
      return 409
    case 'bad-slug':
      return 422
    case 'forbidden':
      return 403
    default:
      return 404
  }
}
