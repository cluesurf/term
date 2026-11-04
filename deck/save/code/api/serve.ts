// The HTTP binding for the base.surf API.
//
// `routes.ts` and `control.ts` define WHAT the API is, as plain operations over seams.
// This turns them into a `node:http` server, which is the only file in the package that
// knows about requests. Keeping it that thin is the point: the operations are testable
// without a socket, and a different host (Fastify, a worker, a queue) is another binding
// rather than a second implementation.
//
// TWO SPELLINGS OF ONE ADDRESS. A repository is reached at
//
//   /@cluesurf/@wordsurf/@alice/repositories/x/branches/main/head           the address grammar
//   /@cluesurf/@wordsurf/resources/language/repositories/tune/branches/...  with a resource key
//   /workspaces/alice/repositories/x/branches/main/head                     the flat form
//
// The first two are `code/base/address.ts`, the chain of spaces and the key. The last is
// what every caller wrote before workspaces nested, resolved by bare slug, and it keeps
// working. Both arrive at one `Located` value and one set of handlers, so there is no
// second router to drift.
//
// See note/project/base/design/control-plane-and-projections.md.

import http from 'http'
import { once } from 'events'
import type { Repository } from '@cluesurf/save/repo/repo'
import type { RecordNode, Value } from '@cluesurf/save/base/type'
import type { Change } from '@cluesurf/save/diff/change'
import * as api from '@cluesurf/save/api/routes'
import { parseChanges, WireError } from '@cluesurf/save/api/wire'
import * as control from '@cluesurf/save/api/control'
import type { ControlStore, Visibility } from '@cluesurf/save/api/control'
import * as forms from '@cluesurf/save/api/form'
import type { FormStore } from '@cluesurf/save/api/form'
import * as scope from '@cluesurf/save/api/scope'
import type { FormStores } from '@cluesurf/save/api/scope'
import type { Contract } from '@cluesurf/save/project/contract'
import { walkArchive } from '@cluesurf/save/api/export'
import { walkZip } from '@cluesurf/save/api/zip'
import { parseAddress } from '@cluesurf/save/base/address'

/**
 * A record as JSON.
 *
 * `fields` is a Map, which `JSON.stringify` renders as `{}`. Serializing a record without
 * this silently returns an empty object for every one of them, and the response looks
 * plausible while carrying nothing.
 */
export function recordJson(record: RecordNode): unknown {
  const fields: Record<string, unknown> = {}

  for (const [name, value] of record.fields) {
    fields[name] = valueJson(value)
  }

  const out: Record<string, unknown> = { type: record.type, fields }

  if (record.mark !== undefined) {
    out.mark = record.mark
  }

  if (record.label !== undefined) {
    out.label = record.label
  }

  return out
}

function valueJson(value: Value): unknown {
  switch (value.kind) {
    // a bigint has no JSON form and `JSON.stringify` throws on one rather than
    // degrading, so it travels as a string and keeps its precision
    case 'integer':
      return { kind: 'integer', value: value.value.toString() }
    case 'collection':
      return {
        kind: 'collection',
        order: value.order,
        items: value.items.map(item => ({
          ...(item.mark === undefined ? {} : { mark: item.mark }),
          ...(item.key === undefined ? {} : { key: item.key }),
          value: valueJson(item.value),
        })),
      }
    case 'record':
      return { kind: 'record', record: recordJson(value.record) }
    default:
      return value
  }
}

export type Session = {
  // who is acting, resolved by the host from whatever it uses for auth. The API never
  // parses a credential: that belongs to the deployment, not to the model.
  user?: string
}

/**
 * Where a request points, in either spelling.
 *
 * `workspace` is the flat form's bare slug, or the last slug of the chain. `spaces` is the
 * whole chain when the address grammar was used and absent for the flat form, so a host
 * that resolves by path can tell the two apart.
 */
export type Located = {
  workspace: string
  spaces?: Array<string>
  resource?: string
  repository?: string
  version?: string
  mark?: string
  // whatever followed the repository (or the space), for the routers here
  rest: Array<string>
}

export type ServeOptions = {
  // Resolve an address to an open Repository. Returning undefined is a 404, so a host can
  // also use this to hide a repository a caller may not see.
  open(input: Located & { repository: string; session: Session }): Promise<Repository | undefined>
  control?: ControlStore
  forms?: FormStore
  // The forms declared at SPACES, keyed by workspace id in the `repository` slot. With
  // `control` and `forms` it turns on the chain: a repository's `/forms` lists what it
  // inherits, a space answers `/forms` and `/forms/register!`, and a name declared once
  // per chain is enforced at both levels (`code/api/scope.ts`).
  spaceForms?: FormStore
  // Authorize a schema (form) WRITE against a repository, before register! runs. A form
  // registration can force a breaking schema change, so it is a privileged write and must
  // be authorized against the repository the caller named — authentication alone is not
  // enough. Returning false is a 403. When omitted, form writes are gated only by
  // authentication, so a deployment with non-public schemas MUST supply this (it is the
  // schema-write analogue of `open()` for repository reads).
  authorizeForm?(input: {
    repository: string
    session: Session
  }): Promise<boolean>
  // Contracts a form registration is checked against. Separate from the store because a
  // deployment may hold contracts somewhere other than its form registry.
  contracts?(repository: string): Promise<Array<Contract>>
  // Identify the caller. Anything unauthenticated arrives with no user, and every write
  // path refuses that rather than acting as nobody.
  session?(request: http.IncomingMessage): Promise<Session>
}

type Params = Record<string, string>

/** Match a route pattern against a path, returning its parameters. */
export function match(pattern: string, path: string): Params | undefined {
  const want = pattern.split('/').filter(Boolean)
  const got = path.split('/').filter(Boolean)

  if (want.length !== got.length) {
    return undefined
  }

  const params: Params = {}

  for (const [i, part] of want.entries()) {
    const here = decodeURIComponent(got[i]!)

    if (part.startsWith(':')) {
      params[part.slice(1)] = here
    } else if (part !== got[i]) {
      return undefined
    }
  }

  return params
}

/**
 * Read either spelling of an address off a path.
 *
 * Returns undefined for a path that is neither, and a fault for one that starts as the
 * address grammar and breaks it, since `/@Bad` is a mistake to report rather than a
 * route to fall through.
 */
export function locate(
  path: string,
): Located | { fault: 'bad-address'; why: string } | undefined {
  if (path.startsWith('/@')) {
    const parsed = parseAddress(path)

    if (!parsed.ok) {
      return { fault: 'bad-address', why: parsed.why }
    }

    const address = parsed.value
    const located: Located = {
      workspace: address.spaces[address.spaces.length - 1]!,
      spaces: address.spaces,
      rest: address.rest,
    }

    if (address.resource !== undefined) {
      located.resource = address.resource
    }

    if (address.repository !== undefined) {
      located.repository = address.repository
    }

    if (address.version !== undefined) {
      located.version = address.version
    }

    if (address.mark !== undefined) {
      located.mark = address.mark
    }

    return located
  }

  const parts = path.split('/').filter(Boolean).map(part => decodeURIComponent(part))

  if (parts[0] !== 'workspaces' || parts[1] === undefined || parts[1].endsWith('!')) {
    return undefined
  }

  const located: Located = { workspace: parts[1], rest: parts.slice(2) }

  if (parts[2] === 'repositories' && parts[3] !== undefined && !parts[3].endsWith('!')) {
    located.repository = parts[3]
    located.rest = parts.slice(4)
  }

  return located
}

// The largest request body accepted. Every write body (a commit's changes, a state or
// changes query) is small; a multi-gigabyte or unbounded chunked body is a
// memory-exhaustion attack, so reading stops and the request is rejected past this.
const MAX_BODY_BYTES = 8 * 1024 * 1024

// Thrown by `body` when the request exceeds the size cap, so the handler answers 413
// instead of buffering an unbounded body into memory.
class BodyTooLargeError extends Error {}

async function body(request: http.IncomingMessage): Promise<Record<string, unknown>> {
  // reject up front on a declared oversize length
  const declared = Number(request.headers['content-length'] ?? 0)
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new BodyTooLargeError()
  }

  const chunks: Array<Buffer> = []
  let total = 0

  for await (const chunk of request) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      throw new BodyTooLargeError()
    }
    chunks.push(buffer)
  }

  if (!chunks.length) {
    return {}
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
      string,
      unknown
    >
  } catch {
    return {}
  }
}

// Session-dependent responses (what `open()` reveals varies by caller) must never be
// cached by a shared CDN under their URL alone, or one caller's private repository would
// be served to another from cache. Every response this API sends is private to its
// session, so the cache header is set unconditionally.
const PRIVATE_CACHE = 'private, no-store'

function send(
  response: http.ServerResponse,
  status: number,
  payload: unknown,
): void {
  response.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': PRIVATE_CACHE,
  })
  response.end(JSON.stringify(payload))
}

/** The rest of a located path as a path again, for `match`. */
function tail(rest: Array<string>): string {
  return `/${rest.join('/')}`
}

/** Build the API server. Call `.listen(port)`. */
export function serveApi(options: ServeOptions): http.Server {
  return http.createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', 'http://localhost')
      const path = url.pathname
      const method = request.method ?? 'GET'
      const session = options.session
        ? await options.session(request)
        : {}

      const located = locate(path)

      if (located && 'fault' in located) {
        return send(response, 404, { fault: 'not-found', what: 'route', why: located.why })
      }

      // ── repository surface ────────────────────────────────────────────────
      if (located?.repository !== undefined) {
        const handled = await serveRepository({
          options,
          located: located as Located & { repository: string },
          request,
          response,
          url,
          method,
          session,
        })

        if (handled) {
          return
        }
      }

      // ── forms ─────────────────────────────────────────────────────────────
      if (options.forms) {
        const handled = await serveForms({
          store: options.forms,
          ...(options.control && options.spaceForms
            ? { scope: { control: options.control, stores: { repositories: options.forms, spaces: options.spaceForms } } }
            : {}),
          contracts: options.contracts,
          authorizeForm: options.authorizeForm,
          request,
          response,
          path,
          method,
          session,
        })

        if (handled) {
          return
        }
      }

      // ── forms on a space ──────────────────────────────────────────────────
      if (options.control && options.forms && options.spaceForms && located && located.repository === undefined) {
        const handled = await serveSpaceForms({
          scope: { control: options.control, stores: { repositories: options.forms, spaces: options.spaceForms } },
          contracts: options.contracts,
          request,
          response,
          located,
          method,
          session,
        })

        if (handled) {
          return
        }
      }

      // ── control plane ─────────────────────────────────────────────────────
      if (options.control) {
        const handled = await serveControl({
          store: options.control,
          request,
          response,
          path,
          located,
          method,
          session,
        })

        if (handled) {
          return
        }
      }

      send(response, 404, { fault: 'not-found', what: 'route' })
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        return send(response, 413, { fault: 'too-large' })
      }
      // never return the raw internal error text: it can carry hashes, invariants, or
      // store-driver details. Log it server-side, answer with a generic fault.
      // eslint-disable-next-line no-console
      console.error('base api internal error', error)
      if (!response.headersSent) {
        send(response, 500, { fault: 'internal' })
      } else {
        response.destroy()
      }
    }
  })
}

function finish<T>(
  response: http.ServerResponse,
  result: api.Result<T>,
  shape?: (value: T) => unknown,
): void {
  if (!result.ok) {
    return send(response, api.statusOf(result), result)
  }

  send(response, 200, shape ? shape(result.value) : result.value)
}

async function serveRepository(input: {
  options: ServeOptions
  located: Located & { repository: string }
  request: http.IncomingMessage
  response: http.ServerResponse
  url: URL
  method: string
  session: Session
}): Promise<boolean> {
  const { options, located, request, response, url, method, session } = input
  const rest = tail(located.rest)

  const open = () => options.open({ ...located, session })

  for (const [suffix, verb] of [
    ['/branches/:branch/head', 'GET'],
    ['/branches/:branch/changes!', 'POST'],
    ['/branches/:branch/state!', 'POST'],
    ['/branches/:branch/commit!', 'POST'],
    ['/branches/:branch/records/:mark', 'GET'],
    ['/branches/:branch/records/:mark/history', 'GET'],
  ] as const) {
    const params = match(suffix, rest)

    if (!params || method !== verb) {
      continue
    }

    const repo = await open()

    if (!repo) {
      send(response, 404, { fault: 'not-found', what: 'repository' })
      return true
    }

    const body_ = verb === 'POST' ? await body(request) : {}
    const branch = params.branch!

    if (suffix === '/branches/:branch/head') {
      finish(response, api.head(repo, branch))
      return true
    }

    if (suffix === '/branches/:branch/changes!') {
      finish(
        response,
        api.changes(repo, {
          branch,
          from: body_.from as string | undefined,
          to: body_.to as string | undefined,
        }),
      )
      return true
    }

    if (suffix === '/branches/:branch/state!') {
      const result = api.state(repo, {
        branch,
        commit: body_.commit as string | undefined,
      })

      finish(response, result, value => ({
        commit: (value as api.State).commit,
        records: (value as api.State).records.map(recordJson),
      }))
      return true
    }

    if (suffix === '/branches/:branch/commit!') {
      // a write with no identified caller acts as nobody, which is the one thing an
      // audit trail cannot survive
      if (!session.user) {
        send(response, 401, { fault: 'unauthenticated', action: 'commit' })
        return true
      }

      // parse the raw JSON changes into typed changes here, at the boundary: this
      // normalizes fields to a Map and integers to bigint, and rejects a malformed
      // body with 422 instead of casting it and crashing deep in applyChanges
      let changes: Array<Change>
      try {
        changes = parseChanges(body_.changes)
      } catch (parseError) {
        send(response, 422, {
          fault: 'invalid',
          message:
            parseError instanceof WireError
              ? parseError.message
              : 'malformed changes',
        })
        return true
      }

      const result = api.commit(repo, {
        branch,
        author: session.user,
        user: session.user,
        message: String(body_.message ?? ''),
        // the timestamp is stamped server-side, never taken from the client: an
        // attacker-chosen (or NaN) commit time corrupts ordering and provenance in
        // an append-only audit history
        time: Date.now(),
        changes,
      })

      finish(response, result)
      return true
    }

    if (suffix === '/branches/:branch/records/:mark') {
      const result = api.readRecord(repo, { branch, mark: params.mark! })

      finish(response, result, value => ({
        commit: (value as { commit: string }).commit,
        record: recordJson((value as { record: RecordNode }).record),
      }))
      return true
    }

    finish(response, api.history(repo, { branch, mark: params.mark! }))
    return true
  }

  if (rest === '/branches' && method === 'GET') {
    const repo = await open()

    if (repo) {
      finish(response, api.branches(repo))
    } else {
      send(response, 404, { fault: 'not-found', what: 'repository' })
    }

    return true
  }

  // ── export ────────────────────────────────────────────────────────────
  const archive = match('/branches/:branch/archive.zip', rest)

  if (archive && method === 'GET') {
    const repo = await open()

    if (!repo) {
      send(response, 404, { fault: 'not-found', what: 'repository' })
      return true
    }

    const commit = url.searchParams.get('commit') ?? repo.head(archive.branch!)

    if (!commit) {
      send(response, 404, { fault: 'no-branch', branch: archive.branch! })
      return true
    }

    // Validate the commit BEFORE writing the 200, and require it to belong to THIS
    // repository (reachable from a ref), not merely exist in the possibly-shared
    // store — otherwise a caller could download another repository's tree by hash.
    // Validating here also avoids throwing AFTER the 200 headers were sent (which
    // would truncate the body and double-write the header).
    if (!repo.containsCommit(commit)) {
      send(response, 404, { fault: 'no-commit', commit })
      return true
    }

    // filename derived from the hash only (hex-safe) plus a sanitized repository
    // slug, so a repository name containing a quote or CR/LF cannot break the header
    const safeRepository = located.repository.replace(/[^A-Za-z0-9._-]/g, '_')
    const name = `${safeRepository}-${commit.slice(0, 12)}.zip`

    response.writeHead(200, {
      'content-type': 'application/zip',
      'content-disposition': `attachment; filename="${name}"`,
      'cache-control': PRIVATE_CACHE,
    })

    // written chunk by chunk, respecting backpressure, so a repository larger than
    // memory still downloads instead of buffering the whole archive in the socket's
    // write queue on a slow connection
    // Backpressure needs to be awaited, and a push walk cannot await inside itself,
    // so the chunks that arrive while the socket is full are held and drained here.
    // That holds at most one entry's worth rather than the archive.
    const pending: Buffer[] = []

    walkZip(
      take => walkArchive({ repo, commit, repository: located.repository }, take),
      chunk => pending.push(chunk),
    )

    for (const chunk of pending) {
      if (!response.write(chunk)) {
        await once(response, 'drain')
      }
    }

    response.end()
    return true
  }

  return false
}

/** The workspace a located path names, for the control plane: by chain, or by bare slug. */
function workspaceRef(located: Located): string | Array<string> {
  return located.spaces ?? located.workspace
}

async function serveControl(input: {
  store: ControlStore
  request: http.IncomingMessage
  response: http.ServerResponse
  path: string
  located: Located | undefined
  method: string
  session: Session
}): Promise<boolean> {
  const { store, response, path, located, method, session } = input

  const answer = <T>(result: control.Answer<T>): true => {
    send(
      response,
      control.controlStatus(result),
      result.ok ? result.value : result,
    )

    return true
  }

  const unauthenticated = (action: string): true => {
    send(response, 401, { fault: 'unauthenticated', action })
    return true
  }

  if (path === '/workspaces' && method === 'GET') {
    return answer(await control.listWorkspaces(store))
  }

  if (path === '/workspaces/create!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('create workspace')
    }

    const data = await body(input.request)

    return answer(
      await control.createWorkspace(store, {
        slug: String(data.slug ?? ''),
        name: String(data.name ?? ''),
        owner: session.user,
        ...(typeof data.parent === 'string' ? { parent: data.parent } : {}),
        ...(data.visibility === 'private' ? { visibility: 'private' as Visibility } : {}),
        ...(typeof data.allows_children === 'boolean'
          ? { allowsChildren: data.allows_children }
          : {}),
      }),
    )
  }

  if (path === '/contracts' && method === 'GET') {
    return answer(await control.listContracts(store))
  }

  if (!located || located.repository !== undefined) {
    return false
  }

  const where = workspaceRef(located)
  const rest = tail(located.rest)

  if (rest === '/' && method === 'GET') {
    const found = await control.readWorkspace(store, where)

    // a former path answers with where the workspace went, so a client can follow
    if (!found.ok && located.spaces && store.workspaceAtFormerPath) {
      const moved = await store.workspaceAtFormerPath(located.spaces)
      const now = moved ? await store.workspaceById(moved) : undefined

      if (now) {
        const to = `/@${now.path.join('/@')}`
        response.writeHead(301, {
          location: to,
          'content-type': 'application/json',
          'cache-control': PRIVATE_CACHE,
        })
        response.end(JSON.stringify({ moved: to }))
        return true
      }
    }

    return answer(found)
  }

  if (rest === '/spaces' && method === 'GET' && located.spaces) {
    return answer(await control.listChildren(store, located.spaces))
  }

  if (rest === '/spaces/create!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('create workspace')
    }

    const parent = await control.readWorkspace(store, where)

    if (!parent.ok) {
      return answer(parent)
    }

    const data = await body(input.request)

    return answer(
      await control.createWorkspace(store, {
        slug: String(data.slug ?? ''),
        name: String(data.name ?? ''),
        owner: typeof data.owner === 'string' ? data.owner : session.user,
        by: session.user,
        parent: parent.value.id,
        ...(data.visibility === 'private' ? { visibility: 'private' as Visibility } : {}),
        ...(typeof data.allows_children === 'boolean'
          ? { allowsChildren: data.allows_children }
          : {}),
      }),
    )
  }

  if (rest === '/rename!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('rename workspace')
    }

    const found = await control.readWorkspace(store, where)

    if (!found.ok) {
      return answer(found)
    }

    const data = await body(input.request)

    return answer(
      await control.renameWorkspace(store, {
        id: found.value.id,
        slug: String(data.slug ?? ''),
        by: session.user,
      }),
    )
  }

  if (rest === '/move!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('move workspace')
    }

    const found = await control.readWorkspace(store, where)

    if (!found.ok) {
      return answer(found)
    }

    const data = await body(input.request)
    let parent: string | undefined

    // the destination is a path (`@cluesurf/@textsurf`) or an id; null means the root
    if (typeof data.parent === 'string' && data.parent.startsWith('@')) {
      const destination = await control.resolveWorkspace(
        store,
        data.parent.split('/').filter(Boolean).map(one => one.replace(/^@/, '')),
      )

      if (!destination.ok) {
        return answer(destination)
      }

      parent = destination.value.workspace.id
    } else if (typeof data.parent === 'string') {
      parent = data.parent
    }

    return answer(
      await control.moveWorkspace(store, { id: found.value.id, parent, by: session.user }),
    )
  }

  if (rest === '/retire!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('retire workspace')
    }

    const found = await control.readWorkspace(store, where)

    if (!found.ok) {
      return answer(found)
    }

    return answer(
      await control.retireWorkspace(store, { id: found.value.id, by: session.user }),
    )
  }

  if (rest === '/repositories' && method === 'GET') {
    const listed = await control.listRepositories(store, where)

    if (!listed.ok) {
      return answer(listed)
    }

    // under a resource key, only the repositories of that key
    return answer({
      ok: true,
      value: listed.value.filter(one => one.resource === located.resource),
    })
  }

  if (rest === '/repositories/create!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('create repository')
    }

    const data = await body(input.request)

    return answer(
      await control.createRepository(store, {
        ...(Array.isArray(where) ? { workspacePath: where } : { workspaceSlug: where }),
        ...(located.resource !== undefined ? { resource: located.resource } : {}),
        slug: String(data.slug ?? ''),
        name: String(data.name ?? ''),
        user: session.user,
        ...(data.visibility === 'private' ? { visibility: 'private' as Visibility } : {}),
      }),
    )
  }

  if (rest === '/members' && method === 'GET') {
    const found = await control.readWorkspace(store, where)

    if (!found.ok) {
      return answer(found)
    }

    return answer(
      await control.listMembers(store, { resourceForm: 'workspace', resource: found.value.id }),
    )
  }

  if (rest === '/members/mutate!' && method === 'POST') {
    if (!session.user) {
      return unauthenticated('mutate members')
    }

    const found = await control.readWorkspace(store, where)

    if (!found.ok) {
      return answer(found)
    }

    const data = await body(input.request)
    const target = String(data.user ?? '')

    if (data.remove === true) {
      return answer(
        await control.removeMember(store, {
          user: target,
          resourceForm: 'workspace',
          resource: found.value.id,
          by: session.user,
        }),
      )
    }

    return answer(
      await control.addMember(store, {
        user: target,
        resourceForm: 'workspace',
        resource: found.value.id,
        role: String(data.role ?? 'member'),
        by: session.user,
      }),
    )
  }

  return false
}

/** The scope seams, when a host binds space forms beside repository forms. */
type Scope = { control: ControlStore; stores: FormStores }

async function serveForms(input: {
  store: FormStore
  scope?: Scope
  contracts?: (repository: string) => Promise<Array<Contract>>
  authorizeForm?: (input: {
    repository: string
    session: Session
  }) => Promise<boolean>
  request: http.IncomingMessage
  response: http.ServerResponse
  path: string
  method: string
  session: Session
}): Promise<boolean> {
  const { store, response, path, method, session } = input

  const answer = <T>(result: forms.FormAnswer<T>): true => {
    send(
      response,
      forms.formStatus(result),
      result.ok ? result.value : result,
    )

    return true
  }

  const list = match('/repositories/:repository/forms', path)

  if (list && method === 'GET') {
    // with the chain bound, the answer is what the repository is validated against:
    // its own forms and the ones it inherits, each saying where it was declared
    if (input.scope) {
      send(
        response,
        200,
        await scope.repositoryForms({ ...input.scope, repository: list.repository! }),
      )

      return true
    }

    return answer(await forms.listForms(store, list.repository!))
  }

  const register = match('/repositories/:repository/forms/register!', path)

  if (register && method === 'POST') {
    if (!session.user) {
      send(response, 401, { fault: 'unauthenticated', action: 'register form' })
      return true
    }

    const repository = register.repository!

    // a form registration can force a breaking schema change on the repository, so it
    // must be authorized against that repository, not merely authenticated
    if (
      input.authorizeForm &&
      !(await input.authorizeForm({ repository, session }))
    ) {
      send(response, 403, { fault: 'forbidden', action: 'register form' })
      return true
    }

    const data = await body(input.request)
    const name = String(data.name ?? '')

    // a name an ancestor space declares is inherited here, never redeclared
    if (input.scope) {
      const against = await scope.declarationsAgainstRepository({
        ...input.scope,
        repository,
        name,
      })

      if (against.length) {
        send(response, 409, { fault: 'declared', name, where: against })
        return true
      }
    }

    return answer(
      await forms.registerForm(store, {
        repository,
        name,
        properties: (data.properties ?? []) as never,
        contracts: input.contracts ? await input.contracts(repository) : [],
        derivation: data.derivation as never,
        time: Number(data.time ?? Date.now()),
        force: data.force === true,
        ...(Array.isArray(data.arms) ? { arms: data.arms as Array<string> } : {}),
        ...(typeof data.key === 'string' ? { key: data.key } : {}),
      }),
    )
  }

  const history = match('/repositories/:repository/forms/:form/versions', path)

  if (history && method === 'GET') {
    return answer(
      await forms.formHistory(store, {
        repository: history.repository!,
        name: history.form!,
      }),
    )
  }

  const one = match('/repositories/:repository/forms/:form', path)

  if (one && method === 'GET') {
    return answer(
      await forms.readForm(store, {
        repository: one.repository!,
        name: one.form!,
      }),
    )
  }

  return false
}

/**
 * Forms beneath a SPACE: what it declares and inherits, and declaring one there for
 * every repository beneath. Registering needs `manage` on the space, because a space
 * form changes what every repository beneath validates against.
 */
async function serveSpaceForms(input: {
  scope: Scope
  contracts?: (repository: string) => Promise<Array<Contract>>
  request: http.IncomingMessage
  response: http.ServerResponse
  located: Located
  method: string
  session: Session
}): Promise<boolean> {
  const { response, located, method, session } = input
  const rest = tail(located.rest)

  if (rest !== '/forms' && rest !== '/forms/register!') {
    return false
  }

  const found = await control.readWorkspace(input.scope.control, workspaceRef(located))

  if (!found.ok) {
    send(response, control.controlStatus(found), found)
    return true
  }

  const workspace = found.value.id

  if (rest === '/forms' && method === 'GET') {
    send(response, 200, await scope.spaceForms({ ...input.scope, workspace }))
    return true
  }

  if (rest === '/forms/register!' && method === 'POST') {
    if (!session.user) {
      send(response, 401, { fault: 'unauthenticated', action: 'register form' })
      return true
    }

    if (!(await control.mayAct(input.scope.control, session.user, 'workspace', workspace))) {
      send(response, 403, { fault: 'forbidden', action: 'register form' })
      return true
    }

    const data = await body(input.request)
    const name = String(data.name ?? '')
    const against = await scope.declarationsAgainstSpace({ ...input.scope, workspace, name })

    if (against.length) {
      send(response, 409, { fault: 'declared', name, where: against })
      return true
    }

    const result = await forms.registerForm(input.scope.stores.spaces, {
      repository: workspace,
      name,
      properties: (data.properties ?? []) as never,
      contracts: input.contracts ? await input.contracts(workspace) : [],
      derivation: data.derivation as never,
      time: Number(data.time ?? Date.now()),
      force: data.force === true,
      ...(Array.isArray(data.arms) ? { arms: data.arms as Array<string> } : {}),
      ...(typeof data.key === 'string' ? { key: data.key } : {}),
    })

    send(response, forms.formStatus(result), result.ok ? result.value : result)
    return true
  }

  return false
}
