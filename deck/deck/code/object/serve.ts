/**
 * A registry HTTP server over the proven registry operations
 * (./registry). It exposes the endpoints the HTTP client (./http) speaks,
 * delegating to `findMissing`, `acceptObject`, `resolveRef`,
 * `publishCommit`, and `buildManifest` over an ObjectStore + RefStore.
 *
 * This is a plain node:http server so it can run in-process for tests with
 * no dependency. The production registry mounts the same handlers as
 * Fastify routes on the shared backend, backed by R2 (objects) and
 * Postgres (refs). The route logic is identical; only the store
 * implementations differ.
 */

import http from 'http'
import { createHash, timingSafeEqual } from 'crypto'
import { ObjectStore } from './store'
import { RefStore } from './refs'
import {
  ScopeKeys,
  acceptObject,
  acceptPack,
  resolveRef,
  publishCommit,
  Ref,
} from './registry'
import { buildManifest } from './graph'

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = []

  for await (const chunk of req) {
    chunks.push(chunk as Buffer)
  }

  return Buffer.concat(chunks)
}

function sendJson(res: http.ServerResponse, code: number, body: unknown): void {
  const text = JSON.stringify(body)
  res.writeHead(code, { 'content-type': 'application/json' })
  res.end(text)
}

/**
 * How writes are authorized.
 *
 * Required rather than optional, and with no default, so a deployed registry cannot be
 * left open by forgetting a field. `'open'` has to be asked for by name, and is only for
 * an in-process test server.
 *
 * One shared token is the whole policy for now: it says "this caller may publish", not
 * who they are or what they own. Ownership, teams, and per-package privileges come later
 * and replace this, rather than building on it.
 */
export type WriteAccess = { token: string } | 'open'

/** The environment variable a deployed registry reads its publish token from. */
export const REGISTRY_TOKEN_VARIABLE = 'TERM_REGISTRY_TOKEN'

/**
 * The write policy for a deployed registry, from the environment.
 *
 * Throws when the variable is missing or blank rather than falling back to `'open'`. A
 * registry that silently accepts anonymous publishes because a variable was not set is
 * the failure this is meant to prevent, and it would not be visible until someone else
 * found it.
 */
export function writeAccessFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): WriteAccess {
  const token = env[REGISTRY_TOKEN_VARIABLE]?.trim()

  if (!token) {
    throw new Error(
      `${REGISTRY_TOKEN_VARIABLE} is not set, so the registry would accept anonymous publishes`,
    )
  }

  return { token }
}

/** The bearer token on a request, or null. */
function bearer(req: http.IncomingMessage): string | null {
  const header = req.headers.authorization

  if (!header) {
    return null
  }

  const match = /^Bearer +(.+)$/i.exec(header.trim())

  return match ? match[1]!.trim() : null
}

/**
 * Is the presented token the expected one?
 *
 * Both sides are hashed first so the comparison is over equal-length digests: it cannot
 * throw on a length mismatch, and it leaks neither the token's content nor its length.
 */
function tokenMatches(presented: string, expected: string): boolean {
  return timingSafeEqual(
    createHash('sha256').update(presented).digest(),
    createHash('sha256').update(expected).digest(),
  )
}

function queryRef(url: URL): Ref | null {
  const version = url.searchParams.get('version')
  const branch = url.searchParams.get('branch')
  const commit = url.searchParams.get('commit')

  if (version) {
    return { kind: 'version', version }
  }

  if (branch) {
    return { kind: 'branch', branch }
  }

  if (commit) {
    return { kind: 'commit', commit }
  }

  return null
}

/** Build a registry HTTP server over the given stores. Call `.listen(port)`. */
export function serveRegistry(input: {
  store: ObjectStore
  refs: RefStore
  scopeKeys: ScopeKeys
  write: WriteAccess
}): http.Server {
  // Reads stay public: installing a package must work with no credentials, and every
  // object is content-addressed, so serving one reveals nothing a hash did not already
  // name. Only the three endpoints that CHANGE the registry are gated.
  const allowsWrite = (req: http.IncomingMessage): boolean => {
    if (input.write === 'open') {
      return true
    }

    const presented = bearer(req)

    return presented !== null && tokenMatches(presented, input.write.token)
  }

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)

      // One gate, ahead of every handler. It allowlists the READS and gates everything
      // else, so the default for anything new is closed. Listing the writes instead
      // would mean a route added later is open until someone remembers to add it here,
      // and that omission is invisible until it is found.
      //
      // Reads are safe to expose: installing a package must work with no credentials,
      // and every object is content-addressed, so serving one reveals nothing its hash
      // did not already name.
      const isRead =
        req.method === 'GET' ||
        req.method === 'HEAD' ||
        // the have / want negotiation. A POST only because the id list is too large for
        // a query string; it reports which ids are absent and changes nothing.
        (req.method === 'POST' &&
          parts[0] === 'packages' &&
          parts[1] === 'verify!')

      if (!isRead && !allowsWrite(req)) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer realm="registry"',
        })
        res.end(
          JSON.stringify({
            error: 'a valid bearer token is required to publish',
          }),
        )

        return
      }

      // POST /package-objects/mutate!  <object bytes>  (id in x-object-id header)
      if (
        req.method === 'POST' &&
        parts[0] === 'package-objects' &&
        parts[1] === 'mutate!'
      ) {
        const id = decodeURIComponent(String(req.headers['x-object-id'] ?? ''))
        const bytes = await readBody(req)
        await acceptObject({ store: input.store, id, bytes })
        sendJson(res, 200, { ok: true })

        return
      }

      // GET / HEAD /package-objects/:id
      if (parts[0] === 'package-objects' && parts[1]) {
        const id = decodeURIComponent(parts.slice(1).join('/'))

        if (req.method === 'HEAD') {
          const has = await input.store.has(id)
          res.writeHead(has ? 200 : 404)
          res.end()

          return
        }

        if (req.method === 'GET') {
          if (!(await input.store.has(id))) {
            res.writeHead(404)
            res.end()

            return
          }

          const bytes = await input.store.get(id)
          res.writeHead(200, {
            'content-type': 'application/octet-stream',
            'cache-control': 'public, immutable, max-age=31536000',
          })
          res.end(bytes)

          return
        }
      }

      // POST /packages/verify!  { ids } -> { missing }  (the delta handshake)
      if (
        req.method === 'POST' &&
        parts[0] === 'packages' &&
        parts[1] === 'verify!'
      ) {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          ids: string[]
        }
        const missing = await input.store.missing(body.ids)
        sendJson(res, 200, { missing })

        return
      }

      // POST /packages/bundle!  <pack bytes> -> { ok, stored }
      // Unpack a batched pack: verify + store each object it holds. One
      // request carries hundreds of objects (see note/term/registry/17).
      if (
        req.method === 'POST' &&
        parts[0] === 'packages' &&
        parts[1] === 'bundle!'
      ) {
        const bytes = await readBody(req)
        const stored = await acceptPack({ store: input.store, bytes })
        sendJson(res, 200, { ok: true, stored })

        return
      }

      // POST /packages/commit!  { package, target, commit, sig, key } -> { ok, ref }
      if (
        req.method === 'POST' &&
        parts[0] === 'packages' &&
        parts[1] === 'commit!'
      ) {
        const body = JSON.parse((await readBody(req)).toString('utf8'))
        const result = await publishCommit({
          store: input.store,
          refs: input.refs,
          scopeKeys: input.scopeKeys,
          package: body.package,
          target: body.target,
          commit: body.commit,
          sig: body.sig,
          key: body.key,
        })
        sendJson(res, 200, result)

        return
      }

      // GET /packages/@scope/:name/references      -> { versions, branches }
      // GET /packages/@scope/:name/files?commit=... -> Manifest (immutable per commit)
      if (
        req.method === 'GET' &&
        parts[0] === 'packages' &&
        parts[1]?.startsWith('@') &&
        parts[2] &&
        parts[3]
      ) {
        const pkg = `${parts[1]}/${parts[2]}`

        if (parts[3] === 'references') {
          const versions = await input.refs.listVersions(pkg)
          const branches = await input.refs.listBranches(pkg)
          sendJson(res, 200, { versions, branches })

          return
        }

        if (parts[3] === 'files') {
          const ref = queryRef(url)

          if (!ref) {
            sendJson(res, 400, { error: 'a ref is required' })

            return
          }

          const commit = await resolveRef({
            refs: input.refs,
            package: pkg,
            ref,
          })
          const manifest = await buildManifest({
            commitId: commit,
            ref: commit,
            package: pkg,
            store: input.store,
          })
          sendJson(res, 200, manifest)

          return
        }
      }

      res.writeHead(404)
      res.end('not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { error: message })
    }
  })
}
