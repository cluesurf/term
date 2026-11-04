// The control-plane API: workspaces, repositories, membership, projections, contracts.
//
// These are the nine objects, not the object graph. A repository operation asks a
// Repository; a control-plane operation asks a database. So this module defines a STORE
// seam rather than importing a driver, exactly as the rest of the package defines
// ObjectStore and RefStore, and base.surf binds it to `move/v3` while a test binds it to
// a map.
//
// What lives here is only what cannot live in a repository: naming, because an address
// has to be unique and that is a consensus question, plus who may act and where a
// projection lives.
//
// WORKSPACES NEST. A workspace has a parent or is a root, and its address is the chain of
// slugs from the root: `@cluesurf/@wordsurf/@alice`. The word is still `workspace` in the
// seam and in the tables; "space" is the same thing said shorter, and the rename is a
// separate job. The rules that make the tree hold, each enforced here and not only by a
// database, since a projection engine may have no unique index:
//
//   - a slug is unique among its siblings, and never equal to an ancestor's slug. The
//     ancestor rule is what lets a site resolve a bare `@x` from its mount as a child
//     first and an ancestor second, with the two never both existing
//   - the chain is at most DEPTH_MAX deep, and a workspace holds children only when it
//     says so (`allowsChildren`), so a customer is a leaf until its product decides
//   - identity is the id. The path is materialised for reading and rewritten on every
//     rename and move, for the whole subtree, and never used as a key
//   - a move refuses a destination inside the workspace's own subtree
//   - a delete is a retirement, of the workspace and everything beneath it
//   - membership on a workspace grants the same on every descendant and on every
//     repository beneath; a repository membership grants that repository alone
//
// A repository is addressed within its workspace by a RESOURCE KEY and a slug. The key is
// a form slug saying what the repository is a repository of (`language`, `script`, a form
// only that workspace declares) or absent for a keyless repository, and the identity is
// `(workspace, resource, slug)` with an absent key distinct from every present one.
//
// See note/project/base/design/model.md,
// note/project/base/design/control-plane-and-projections.md and
// note/project/mesh/model/workspace/shared-repositories-and-libraries.md.

import { randomUUID } from 'crypto'
import type { Contract } from '@cluesurf/save/project/contract'
import { DEPTH_MAX, slugFault } from '@cluesurf/save/base/address'

export type Visibility = 'public' | 'private'

export type Workspace = {
  id: string
  slug: string
  name: string
  owner: string
  // the containing workspace's id; absent at a root
  parent?: string
  // the chain of slugs from the root to this one, this one last. Derived, materialised.
  path: Array<string>
  // `path.length`, kept so a store can index the tree by level
  depth: number
  visibility: Visibility
  // whether workspaces may be created beneath this one
  allowsChildren: boolean
  // epoch milliseconds when it was retired; absent while it lives
  retired?: number
}

export type RepositoryRow = {
  id: string
  workspace: string
  slug: string
  name: string
  // the form slug the repository is keyed by; absent for a keyless one
  resource?: string
  visibility?: Visibility
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
  workspaceById(id: string): Promise<Workspace | undefined>
  // The child of `parent` called `slug`; a root when `parent` is undefined. This is the
  // one read a path resolution repeats per segment.
  workspaceChild(input: {
    parent: string | undefined
    slug: string
  }): Promise<Workspace | undefined>
  children(parent: string | undefined): Promise<Array<Workspace>>
  // The one workspace anywhere in the tree with this slug, for a host that keeps slugs
  // globally unique (a site's handle namespace does) and for callers that predate
  // nesting. A host with two workspaces of one slug answers whichever it likes, so a
  // path is the reliable address and this is the convenience.
  workspaceBySlug(slug: string): Promise<Workspace | undefined>
  putWorkspace(workspace: Workspace): Promise<void>
  // Optional: remember a path a workspace used to answer at, so a request to it can
  // redirect. A store without it forgets, and an old link 404s.
  rememberPath?(input: { workspace: string; path: Array<string> }): Promise<void>
  workspaceAtFormerPath?(path: Array<string>): Promise<string | undefined>

  repositories(workspace: string): Promise<Array<RepositoryRow>>
  repositoryBySlug(input: {
    workspace: string
    resource?: string
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
  // Optional ATOMIC "drop unless this is the last member". A real store implements it
  // as one conditional delete so two concurrent removals cannot both pass a separate
  // count-check and orphan the resource (a TOCTOU race). Returns whether the member was
  // dropped, and whether the removal was declined because it was the last one. A store
  // without it falls back to the non-atomic read-count-then-drop below.
  dropMemberIfNotLast?(input: {
    user: string
    resourceForm: Member['resourceForm']
    resource: string
  }): Promise<{ dropped: boolean; wasLast: boolean }>

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
  // a tree rule refused the change: too deep, a slug equal to an ancestor's, a move
  // into the workspace's own subtree, a parent that takes no children, a retired parent
  | { fault: 'refused'; why: string }

export type Answer<T> = { ok: true; value: T } | ({ ok: false } & ControlFault)

const yes = <T>(value: T): Answer<T> => ({ ok: true, value })
const no = <T>(fault: ControlFault): Answer<T> => ({ ok: false, ...fault })

// Names that would collide with a route segment or read as a system resource. A
// workspace slug never collides with a host word in an address, because it is
// `@`-prefixed there, but the same slug is a bare segment on a site (`word.surf/alice`),
// so the list stays.
const RESERVED = new Set([
  'new', 'edit', 'settings', 'admin', 'api', 'base', 'repositories', 'resources',
  'records', 'spaces', 'workspaces', 'login', 'logout', 'sessions', 'levels',
])

export function checkSlug(slug: string): ControlFault | undefined {
  const why = slugFault(slug)

  if (why) {
    return { fault: 'bad-slug', slug, why }
  }

  if (RESERVED.has(slug)) {
    return { fault: 'bad-slug', slug, why: 'reserved' }
  }

  return undefined
}

// ── the tree ──────────────────────────────────────────────────────────────────

/** The chain from the root to a workspace, root first. Empty when the id is unknown. */
export async function chainOf(
  store: ControlStore,
  workspace: string,
): Promise<Array<Workspace>> {
  const chain: Array<Workspace> = []
  let at: string | undefined = workspace

  // bounded by the depth cap plus one, so a corrupted parent cycle cannot spin
  for (let step = 0; at !== undefined && step <= DEPTH_MAX; step += 1) {
    const found: Workspace | undefined = await store.workspaceById(at)

    if (!found) {
      break
    }

    chain.unshift(found)
    at = found.parent
  }

  return chain
}

/** Every workspace beneath one, at any depth, shallowest first. */
export async function subtreeOf(
  store: ControlStore,
  workspace: string,
): Promise<Array<Workspace>> {
  const found: Array<Workspace> = []
  let level = await store.children(workspace)

  while (level.length) {
    found.push(...level)
    const next: Array<Workspace> = []

    for (const one of level) {
      next.push(...(await store.children(one.id)))
    }

    level = next
  }

  return found
}

/**
 * Resolve a path, `['cluesurf', 'wordsurf', 'alice']`, to the workspace it names and the
 * chain above it. One read per segment, each a child lookup on an indexed pair.
 */
export async function resolveWorkspace(
  store: ControlStore,
  path: Array<string>,
): Promise<Answer<{ workspace: Workspace; chain: Array<Workspace> }>> {
  if (!path.length) {
    return no({ fault: 'not-found', what: 'workspace', slug: '' })
  }

  const chain: Array<Workspace> = []
  let parent: string | undefined

  for (const slug of path) {
    const found = await store.workspaceChild({ parent, slug })

    if (!found) {
      return no({ fault: 'not-found', what: 'workspace', slug: path.join('/') })
    }

    chain.push(found)
    parent = found.id
  }

  return yes({ workspace: chain[chain.length - 1]!, chain })
}

/**
 * The effective visibility along a chain: the narrowest. A repository cannot be public
 * inside a private workspace, so a customer's privacy setting is a ceiling on everything
 * they hold.
 */
export function effectiveVisibility(
  chain: Array<{ visibility?: Visibility }>,
): Visibility {
  return chain.some(one => one.visibility === 'private') ? 'private' : 'public'
}

/** Why a slug may not sit beneath these ancestors, or undefined when it may. */
function ancestorClash(
  slug: string,
  ancestors: Array<Workspace>,
): string | undefined {
  const above = ancestors.find(one => one.slug === slug)

  return above
    ? `"${slug}" is the slug of an ancestor, @${above.path.join('/@')}`
    : undefined
}

/**
 * Create a workspace, at the root or beneath a parent.
 *
 * Uniqueness is checked here AND has to be enforced by a unique constraint in the
 * database. This check gives a good error; the constraint is what makes it true, because
 * two simultaneous creates both see nothing and both proceed.
 *
 * Beneath a parent, the actor (`by`, defaulting to the owner) needs to be able to act on
 * the parent, the parent has to allow children and not be retired, the chain has to stay
 * within the cap, and the slug may equal neither a sibling's nor an ancestor's.
 */
export async function createWorkspace(
  store: ControlStore,
  input: {
    slug: string
    name: string
    owner: string
    parent?: string
    by?: string
    visibility?: Visibility
    allowsChildren?: boolean
  },
): Promise<Answer<Workspace>> {
  const bad = checkSlug(input.slug)

  if (bad) {
    return no(bad)
  }

  let chain: Array<Workspace> = []

  if (input.parent !== undefined) {
    chain = await chainOf(store, input.parent)
    const parent = chain[chain.length - 1]

    if (!parent || parent.id !== input.parent) {
      return no({ fault: 'not-found', what: 'workspace', slug: input.parent })
    }

    if (parent.retired !== undefined) {
      return no({ fault: 'refused', why: 'the parent is retired' })
    }

    if (!parent.allowsChildren) {
      return no({ fault: 'refused', why: `@${parent.path.join('/@')} does not hold child workspaces` })
    }

    if (chain.length + 1 > DEPTH_MAX) {
      return no({ fault: 'refused', why: `deeper than ${DEPTH_MAX} workspaces` })
    }

    const clash = ancestorClash(input.slug, chain)

    if (clash) {
      return no({ fault: 'refused', why: clash })
    }

    if (!(await mayAct(store, input.by ?? input.owner, 'workspace', parent.id))) {
      return no({
        fault: 'forbidden',
        user: input.by ?? input.owner,
        action: 'create workspace beneath',
      })
    }
  }

  if (await store.workspaceChild({ parent: input.parent, slug: input.slug })) {
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
    path: [...chain.map(one => one.slug), input.slug],
    depth: chain.length + 1,
    visibility: input.visibility ?? 'public',
    // a root holds children unless told otherwise; beneath a root, a workspace is a
    // leaf until somebody says it is not
    allowsChildren: input.allowsChildren ?? input.parent === undefined,
  }

  if (input.parent !== undefined) {
    workspace.parent = input.parent
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

/** Read a workspace by path (`['cluesurf', 'wordsurf']`) or, for a caller that predates nesting, by bare slug. */
export async function readWorkspace(
  store: ControlStore,
  where: string | Array<string>,
): Promise<Answer<Workspace>> {
  if (Array.isArray(where)) {
    const found = await resolveWorkspace(store, where)

    return found.ok ? yes(found.value.workspace) : found
  }

  const workspace = await store.workspaceBySlug(where)

  return workspace
    ? yes(workspace)
    : no({ fault: 'not-found', what: 'workspace', slug: where })
}

export async function listChildren(
  store: ControlStore,
  path: Array<string>,
): Promise<Answer<Array<Workspace>>> {
  const found = await resolveWorkspace(store, path)

  return found.ok ? yes(await store.children(found.value.workspace.id)) : found
}

/** Rewrite the materialised path of a subtree after a rename or a move. */
async function repath(
  store: ControlStore,
  root: Workspace,
  above: Array<string>,
): Promise<void> {
  const previous = root.path
  const next: Workspace = {
    ...root,
    path: [...above, root.slug],
    depth: above.length + 1,
  }

  await store.putWorkspace(next)

  if (store.rememberPath && previous.join('/') !== next.path.join('/')) {
    await store.rememberPath({ workspace: root.id, path: previous })
  }

  for (const child of await store.children(root.id)) {
    await repath(store, child, next.path)
  }
}

/**
 * Rename a workspace. The new slug faces the same sibling and ancestor rules as a
 * create, and every descendant's path is rewritten with it. The previous path is
 * remembered so a link to it can redirect.
 */
export async function renameWorkspace(
  store: ControlStore,
  input: { id: string; slug: string; by: string },
): Promise<Answer<Workspace>> {
  const bad = checkSlug(input.slug)

  if (bad) {
    return no(bad)
  }

  const chain = await chainOf(store, input.id)
  const workspace = chain[chain.length - 1]

  if (!workspace || workspace.id !== input.id) {
    return no({ fault: 'not-found', what: 'workspace', slug: input.id })
  }

  if (!(await mayAct(store, input.by, 'workspace', workspace.id))) {
    return no({ fault: 'forbidden', user: input.by, action: 'rename workspace' })
  }

  if (workspace.slug === input.slug) {
    return yes(workspace)
  }

  const clash = ancestorClash(input.slug, chain.slice(0, -1))

  if (clash) {
    return no({ fault: 'refused', why: clash })
  }

  if (await store.workspaceChild({ parent: workspace.parent, slug: input.slug })) {
    return no({ fault: 'taken', slug: input.slug })
  }

  // a descendant may not carry the slug its ancestor is taking
  for (const below of await subtreeOf(store, workspace.id)) {
    if (below.slug === input.slug) {
      return no({
        fault: 'refused',
        why: `"${input.slug}" is the slug of a descendant, @${below.path.join('/@')}`,
      })
    }
  }

  const renamed: Workspace = { ...workspace, slug: input.slug }

  await repath(store, renamed, chain.slice(0, -1).map(one => one.slug))

  return yes((await store.workspaceById(workspace.id))!)
}

/**
 * Move a workspace beneath another parent, or to the root with `parent` undefined.
 *
 * An admin action on both sides: the actor must be able to act on the workspace (which
 * an ancestor's admin can) and on the destination. The destination may not be inside the
 * workspace's own subtree, the deepest descendant must still fit under the cap, and no
 * slug in the moved subtree may equal a slug on the new chain above it.
 */
export async function moveWorkspace(
  store: ControlStore,
  input: { id: string; parent: string | undefined; by: string },
): Promise<Answer<Workspace>> {
  const workspace = await store.workspaceById(input.id)

  if (!workspace) {
    return no({ fault: 'not-found', what: 'workspace', slug: input.id })
  }

  if (!(await mayAct(store, input.by, 'workspace', workspace.id))) {
    return no({ fault: 'forbidden', user: input.by, action: 'move workspace' })
  }

  if (workspace.parent === input.parent) {
    return yes(workspace)
  }

  let above: Array<Workspace> = []

  if (input.parent !== undefined) {
    if (input.parent === workspace.id) {
      return no({ fault: 'refused', why: 'a workspace cannot be its own parent' })
    }

    above = await chainOf(store, input.parent)
    const parent = above[above.length - 1]

    if (!parent || parent.id !== input.parent) {
      return no({ fault: 'not-found', what: 'workspace', slug: input.parent })
    }

    if (above.some(one => one.id === workspace.id)) {
      return no({ fault: 'refused', why: 'the destination is inside the workspace being moved' })
    }

    if (parent.retired !== undefined) {
      return no({ fault: 'refused', why: 'the destination is retired' })
    }

    if (!parent.allowsChildren) {
      return no({ fault: 'refused', why: `@${parent.path.join('/@')} does not hold child workspaces` })
    }

    if (!(await mayAct(store, input.by, 'workspace', parent.id))) {
      return no({ fault: 'forbidden', user: input.by, action: 'move workspace into' })
    }
  }

  if (await store.workspaceChild({ parent: input.parent, slug: workspace.slug })) {
    return no({ fault: 'taken', slug: workspace.slug })
  }

  const subtree = await subtreeOf(store, workspace.id)
  const deepest = subtree.reduce(
    (most, one) => Math.max(most, one.depth - workspace.depth),
    0,
  )

  if (above.length + 1 + deepest > DEPTH_MAX) {
    return no({ fault: 'refused', why: `deeper than ${DEPTH_MAX} workspaces` })
  }

  for (const one of [workspace, ...subtree]) {
    const clash = ancestorClash(one.slug, above)

    if (clash) {
      return no({ fault: 'refused', why: clash })
    }
  }

  const moved: Workspace = { ...workspace }

  if (input.parent === undefined) {
    delete moved.parent
  } else {
    moved.parent = input.parent
  }

  await repath(store, moved, above.map(one => one.slug))

  return yes((await store.workspaceById(workspace.id))!)
}

/**
 * Retire a workspace and everything beneath it. Retirement is the only delete: the
 * workspace owns its descendants and their repositories, and bytes are reclaimed later
 * by reachability across the host, so nothing is torn out from under a reader.
 */
export async function retireWorkspace(
  store: ControlStore,
  input: { id: string; by: string; time?: number },
): Promise<Answer<{ retired: Array<string> }>> {
  const workspace = await store.workspaceById(input.id)

  if (!workspace) {
    return no({ fault: 'not-found', what: 'workspace', slug: input.id })
  }

  if (!(await mayAct(store, input.by, 'workspace', workspace.id))) {
    return no({ fault: 'forbidden', user: input.by, action: 'retire workspace' })
  }

  const time = input.time ?? Date.now()
  const retired: Array<string> = []

  for (const one of [workspace, ...(await subtreeOf(store, workspace.id))]) {
    if (one.retired === undefined) {
      await store.putWorkspace({ ...one, retired: time })
      retired.push(one.id)
    }
  }

  return yes({ retired })
}

// ── repositories ──────────────────────────────────────────────────────────────

/** The workspace a repository input names: an id, a path, or a bare slug. */
async function workspaceNamed(
  store: ControlStore,
  where: { workspace?: string; workspacePath?: Array<string>; workspaceSlug?: string },
): Promise<Workspace | undefined> {
  if (where.workspace !== undefined) {
    return store.workspaceById(where.workspace)
  }

  if (where.workspacePath !== undefined) {
    const found = await resolveWorkspace(store, where.workspacePath)

    return found.ok ? found.value.workspace : undefined
  }

  if (where.workspaceSlug !== undefined) {
    return store.workspaceBySlug(where.workspaceSlug)
  }

  return undefined
}

/**
 * Create a repository inside a workspace, keyed or keyless.
 *
 * Requires membership on the workspace or an ancestor. An unauthorized create is
 * `forbidden` rather than `not-found`, because the workspace's existence is not a secret
 * and pretending otherwise makes every permission bug look like a missing row.
 */
export async function createRepository(
  store: ControlStore,
  input: {
    workspace?: string
    workspacePath?: Array<string>
    workspaceSlug?: string
    resource?: string
    slug: string
    name: string
    user: string
    visibility?: Visibility
  },
): Promise<Answer<RepositoryRow>> {
  const bad = checkSlug(input.slug)

  if (bad) {
    return no(bad)
  }

  if (input.resource !== undefined) {
    const why = slugFault(input.resource)

    if (why) {
      return no({ fault: 'bad-slug', slug: input.resource, why })
    }
  }

  const workspace = await workspaceNamed(store, input)

  if (!workspace) {
    return no({
      fault: 'not-found',
      what: 'workspace',
      slug: input.workspacePath?.join('/') ?? input.workspaceSlug ?? input.workspace ?? '',
    })
  }

  if (workspace.retired !== undefined) {
    return no({ fault: 'refused', why: 'the workspace is retired' })
  }

  if (!(await mayAct(store, input.user, 'workspace', workspace.id))) {
    return no({ fault: 'forbidden', user: input.user, action: 'create repository' })
  }

  const where = { workspace: workspace.id, slug: input.slug } as {
    workspace: string
    resource?: string
    slug: string
  }

  if (input.resource !== undefined) {
    where.resource = input.resource
  }

  if (await store.repositoryBySlug(where)) {
    return no({ fault: 'taken', slug: input.slug })
  }

  const repository: RepositoryRow = {
    // server-generated id, never from the request (see createWorkspace)
    id: randomUUID(),
    workspace: workspace.id,
    slug: input.slug,
    name: input.name,
  }

  if (input.resource !== undefined) {
    repository.resource = input.resource
  }

  if (input.visibility !== undefined) {
    repository.visibility = input.visibility
  }

  await store.putRepository(repository)

  return yes(repository)
}

export async function listRepositories(
  store: ControlStore,
  where: string | Array<string>,
): Promise<Answer<Array<RepositoryRow>>> {
  const workspace = await workspaceNamed(
    store,
    Array.isArray(where) ? { workspacePath: where } : { workspaceSlug: where },
  )

  if (!workspace) {
    return no({
      fault: 'not-found',
      what: 'workspace',
      slug: Array.isArray(where) ? where.join('/') : where,
    })
  }

  return yes(await store.repositories(workspace.id))
}

/**
 * Resolve an address to its workspace and repository, the name the whole platform is
 * addressed by. `workspace` is a path (`['cluesurf', 'wordsurf']`) or, for a caller
 * that predates nesting, a bare slug.
 */
export async function resolve(
  store: ControlStore,
  input: { workspace: string | Array<string>; resource?: string; repository: string },
): Promise<Answer<{ workspace: Workspace; chain: Array<Workspace>; repository: RepositoryRow }>> {
  let chain: Array<Workspace>

  if (Array.isArray(input.workspace)) {
    const found = await resolveWorkspace(store, input.workspace)

    if (!found.ok) {
      return found
    }

    chain = found.value.chain
  } else {
    const found = await store.workspaceBySlug(input.workspace)

    if (!found) {
      return no({ fault: 'not-found', what: 'workspace', slug: input.workspace })
    }

    chain = await chainOf(store, found.id)
  }

  const workspace = chain[chain.length - 1]!
  const where = { workspace: workspace.id, slug: input.repository } as {
    workspace: string
    resource?: string
    slug: string
  }

  if (input.resource !== undefined) {
    where.resource = input.resource
  }

  const repository = await store.repositoryBySlug(where)

  return repository
    ? yes({ workspace, chain, repository })
    : no({ fault: 'not-found', what: 'repository', slug: input.repository })
}

// ── membership ────────────────────────────────────────────────────────────────

async function isMember(
  store: ControlStore,
  user: string,
  resourceForm: Member['resourceForm'],
  resource: string,
): Promise<boolean> {
  const held = await store.members({ resourceForm, resource })

  return held.some(member => member.user === user)
}

/**
 * Whether a user may act on a resource.
 *
 * Membership on the resource itself, OR on the workspace that contains it, OR on any
 * workspace above that. Without the chain a workspace owner cannot grant access to their
 * own repository, and a product's admin cannot reach a customer's space, which is what
 * support and moderation need. Repository membership stays narrower than workspace
 * membership: it grants that repository and nothing else.
 */
export async function mayAct(
  store: ControlStore,
  user: string,
  resourceForm: Member['resourceForm'],
  resource: string,
): Promise<boolean> {
  if (await isMember(store, user, resourceForm, resource)) {
    return true
  }

  let workspace: string | undefined

  if (resourceForm === 'workspace') {
    workspace = (await store.workspaceById(resource))?.parent
  } else if (store.workspaceOfRepository) {
    workspace = await store.workspaceOfRepository(resource)
  } else {
    for (const candidate of await store.workspaces()) {
      const found = await store.repositories(candidate.id)

      if (found.some(repository => repository.id === resource)) {
        workspace = candidate.id
        break
      }
    }
  }

  if (workspace === undefined) {
    return false
  }

  for (const above of await chainOf(store, workspace)) {
    if (await isMember(store, user, 'workspace', above.id)) {
      return true
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

  const target = {
    user: input.user,
    resourceForm: input.resourceForm,
    resource: input.resource,
  }

  // Atomic path: one conditional delete decides last-member and removal together, so
  // two concurrent removes cannot both slip past a separate count check.
  if (store.dropMemberIfNotLast) {
    const result = await store.dropMemberIfNotLast(target)
    if (result.wasLast) {
      return no({
        fault: 'forbidden',
        user: input.by,
        action: 'remove the last member',
      })
    }
    return yes({ removed: input.user })
  }

  // Fallback: read the count, then drop. Not atomic — a store that can race concurrent
  // writers should provide dropMemberIfNotLast above.
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

  await store.dropMember(target)

  return yes({ removed: input.user })
}

export async function listMembers(
  store: ControlStore,
  input: { resourceForm: Member['resourceForm']; resource: string },
): Promise<Answer<Array<Member>>> {
  return yes(await store.members(input))
}

// ── projections and contracts ─────────────────────────────────────────────────

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

// ── routes ────────────────────────────────────────────────────────────────────

// `:space+` stands for one or more `@slug` segments, the address grammar in
// `code/base/address.ts`. The `/workspaces/:workspace` forms are the flat spelling a
// caller that predates nesting still uses, resolved by bare slug.
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
  { method: 'GET', path: '/:space+' },
  { method: 'GET', path: '/:space+/spaces' },
  { method: 'POST', path: '/:space+/spaces/create!' },
  { method: 'POST', path: '/:space+/rename!' },
  { method: 'POST', path: '/:space+/move!' },
  { method: 'POST', path: '/:space+/retire!' },
  { method: 'GET', path: '/:space+/repositories' },
  { method: 'POST', path: '/:space+/repositories/create!' },
  { method: 'GET', path: '/:space+/resources/:form/repositories' },
  { method: 'POST', path: '/:space+/resources/:form/repositories/create!' },
  { method: 'GET', path: '/:space+/members' },
  { method: 'POST', path: '/:space+/members/mutate!' },
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
    case 'refused':
      return 422
    case 'forbidden':
      return 403
    default:
      return 404
  }
}
