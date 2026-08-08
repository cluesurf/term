// The HTTP binding for the base.surf API.
//
// `routes.ts` and `control.ts` define WHAT the API is, as plain operations over seams.
// This turns them into a `node:http` server, which is the only file in the package that
// knows about requests. Keeping it that thin is the point: the operations are testable
// without a socket, and a different host (Fastify, a worker, a queue) is another binding
// rather than a second implementation.
//
// See note/library/base/design/control-plane-and-projections.md.

import http from 'http'
import { once } from 'events'
import type { Repository } from '@term/base/code/repo/repo'
import type { RecordNode, Value } from '@term/base/code/base/type'
import type { Change } from '@term/base/code/diff/change'
import * as api from '@term/base/code/api/routes'
import * as control from '@term/base/code/api/control'
import type { ControlStore } from '@term/base/code/api/control'
import * as forms from '@term/base/code/api/form'
import type { FormStore } from '@term/base/code/api/form'
import type { Contract } from '@term/base/code/project/contract'
import { exportArchive } from '@term/base/code/api/export'
import { encodeZip } from '@term/base/code/api/zip'

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

export type ServeOptions = {
  // Resolve `@workspace/repository` to an open Repository. Returning undefined is a 404,
  // so a host can also use this to hide a repository a caller may not see.
  open(input: {
    workspace: string
    repository: string
    session: Session
  }): Promise<Repository | undefined>
  control?: ControlStore
  forms?: FormStore
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

      // ── repository surface ────────────────────────────────────────────────
      const repoPattern =
        '/workspaces/:workspace/repositories/:repository/branches/:branch'

      for (const [suffix, verb] of [
        ['/head', 'GET'],
        ['/changes!', 'POST'],
        ['/state!', 'POST'],
        ['/commit!', 'POST'],
        ['/records/:mark', 'GET'],
        ['/records/:mark/history', 'GET'],
      ] as const) {
        const params = match(`${repoPattern}${suffix}`, path)

        if (!params || method !== verb) {
          continue
        }

        const repo = await options.open({
          workspace: params.workspace!,
          repository: params.repository!,
          session,
        })

        if (!repo) {
          return send(response, 404, { fault: 'not-found', what: 'repository' })
        }

        const input = verb === 'POST' ? await body(request) : {}
        const branch = params.branch!

        if (suffix === '/head') {
          return finish(response, api.head(repo, branch))
        }

        if (suffix === '/changes!') {
          return finish(
            response,
            api.changes(repo, {
              branch,
              from: input.from as string | undefined,
              to: input.to as string | undefined,
            }),
          )
        }

        if (suffix === '/state!') {
          const result = api.state(repo, {
            branch,
            commit: input.commit as string | undefined,
          })

          return finish(response, result, value => ({
            commit: (value as api.State).commit,
            records: (value as api.State).records.map(recordJson),
          }))
        }

        if (suffix === '/commit!') {
          // a write with no identified caller acts as nobody, which is the one thing an
          // audit trail cannot survive
          if (!session.user) {
            return send(response, 401, {
              fault: 'unauthenticated',
              action: 'commit',
            })
          }

          const result = api.commit(repo, {
            branch,
            author: session.user,
            user: session.user,
            message: String(input.message ?? ''),
            // the timestamp is stamped server-side, never taken from the client: an
            // attacker-chosen (or NaN) commit time corrupts ordering and provenance in
            // an append-only audit history
            time: Date.now(),
            // raw JSON changes; api.commit validates + normalizes them (fields to a Map,
            // integers to bigint) and returns a 422 fault on anything malformed
            changes: input.changes,
          })

          return finish(response, result)
        }

        if (suffix === '/records/:mark') {
          const result = api.readRecord(repo, { branch, mark: params.mark! })

          return finish(response, result, value => ({
            commit: (value as { commit: string }).commit,
            record: recordJson((value as { record: RecordNode }).record),
          }))
        }

        return finish(
          response,
          api.history(repo, { branch, mark: params.mark! }),
        )
      }

      const branchList = match(
        '/workspaces/:workspace/repositories/:repository/branches',
        path,
      )

      if (branchList && method === 'GET') {
        const repo = await options.open({
          workspace: branchList.workspace!,
          repository: branchList.repository!,
          session,
        })

        return repo
          ? finish(response, api.branches(repo))
          : send(response, 404, { fault: 'not-found', what: 'repository' })
      }

      // ── export ────────────────────────────────────────────────────────────
      const archive = match(
        '/workspaces/:workspace/repositories/:repository/branches/:branch/archive.zip',
        path,
      )

      if (archive && method === 'GET') {
        const repo = await options.open({
          workspace: archive.workspace!,
          repository: archive.repository!,
          session,
        })

        if (!repo) {
          return send(response, 404, { fault: 'not-found', what: 'repository' })
        }

        const commit = url.searchParams.get('commit') ?? repo.head(archive.branch!)

        if (!commit) {
          return send(response, 404, { fault: 'no-branch', branch: archive.branch! })
        }

        // Validate the commit BEFORE writing the 200, and require it to belong to THIS
        // repository (reachable from a ref), not merely exist in the possibly-shared
        // store — otherwise a caller could download another repository's tree by hash.
        // Validating here also avoids throwing AFTER the 200 headers were sent (which
        // would truncate the body and double-write the header).
        if (!repo.containsCommit(commit)) {
          return send(response, 404, { fault: 'no-commit', commit })
        }

        // filename derived from the hash only (hex-safe) plus a sanitized repository
        // slug, so a repository name containing a quote or CR/LF cannot break the header
        const safeRepository = String(archive.repository).replace(/[^A-Za-z0-9._-]/g, '_')
        const name = `${safeRepository}-${commit.slice(0, 12)}.zip`

        response.writeHead(200, {
          'content-type': 'application/zip',
          'content-disposition': `attachment; filename="${name}"`,
          'cache-control': PRIVATE_CACHE,
        })

        // written chunk by chunk, respecting backpressure, so a repository larger than
        // memory still downloads instead of buffering the whole archive in the socket's
        // write queue on a slow connection
        for (const chunk of encodeZip(
          exportArchive({ repo, commit, repository: archive.repository! }),
        )) {
          if (!response.write(chunk)) {
            await once(response, 'drain')
          }
        }

        return response.end()
      }

      // ── forms ─────────────────────────────────────────────────────────────
      if (options.forms) {
        const handled = await serveForms({
          store: options.forms,
          contracts: options.contracts,
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

      // ── control plane ─────────────────────────────────────────────────────
      if (options.control) {
        const handled = await serveControl({
          store: options.control,
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

async function serveControl(input: {
  store: ControlStore
  request: http.IncomingMessage
  response: http.ServerResponse
  path: string
  method: string
  session: Session
}): Promise<boolean> {
  const { store, response, path, method, session } = input

  const answer = <T>(result: control.Answer<T>): true => {
    send(
      response,
      control.controlStatus(result),
      result.ok ? result.value : result,
    )

    return true
  }

  if (path === '/workspaces' && method === 'GET') {
    return answer(await control.listWorkspaces(store))
  }

  if (path === '/workspaces/create!' && method === 'POST') {
    if (!session.user) {
      send(response, 401, { fault: 'unauthenticated', action: 'create workspace' })
      return true
    }

    const data = await body(input.request)

    return answer(
      await control.createWorkspace(store, {
        slug: String(data.slug ?? ''),
        name: String(data.name ?? ''),
        owner: session.user,
      }),
    )
  }

  const one = match('/workspaces/:workspace', path)

  if (one && method === 'GET') {
    return answer(await control.readWorkspace(store, one.workspace!))
  }

  const repos = match('/workspaces/:workspace/repositories', path)

  if (repos && method === 'GET') {
    return answer(await control.listRepositories(store, repos.workspace!))
  }

  const create = match('/workspaces/:workspace/repositories/create!', path)

  if (create && method === 'POST') {
    if (!session.user) {
      send(response, 401, { fault: 'unauthenticated', action: 'create repository' })
      return true
    }

    const data = await body(input.request)

    return answer(
      await control.createRepository(store, {
        workspaceSlug: create.workspace!,
        slug: String(data.slug ?? ''),
        name: String(data.name ?? ''),
        user: session.user,
      }),
    )
  }

  if (path === '/contracts' && method === 'GET') {
    return answer(await control.listContracts(store))
  }

  return false
}

async function serveForms(input: {
  store: FormStore
  contracts?: (repository: string) => Promise<Array<Contract>>
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
    return answer(await forms.listForms(store, list.repository!))
  }

  const register = match('/repositories/:repository/forms/register!', path)

  if (register && method === 'POST') {
    if (!session.user) {
      send(response, 401, { fault: 'unauthenticated', action: 'register form' })
      return true
    }

    const data = await body(input.request)
    const repository = register.repository!

    return answer(
      await forms.registerForm(store, {
        repository,
        name: String(data.name ?? ''),
        properties: (data.properties ?? []) as never,
        contracts: input.contracts ? await input.contracts(repository) : [],
        derivation: data.derivation as never,
        time: Number(data.time ?? Date.now()),
        force: data.force === true,
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
