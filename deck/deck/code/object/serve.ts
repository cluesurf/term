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
import { ObjectStore } from './store'
import { RefStore } from './refs'
import {
  ScopeKeys,
  acceptObject,
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
}): http.Server {
  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      const parts = url.pathname.split('/').filter(Boolean)

      // /object/:id  (GET, HEAD, PUT)
      if (parts[0] === 'object' && parts[1]) {
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

        if (req.method === 'PUT') {
          const bytes = await readBody(req)
          await acceptObject({ store: input.store, id, bytes })
          sendJson(res, 200, { ok: true })

          return
        }
      }

      // POST /publish/negotiate  { ids } -> { missing }
      if (
        req.method === 'POST' &&
        parts[0] === 'publish' &&
        parts[1] === 'negotiate'
      ) {
        const body = JSON.parse((await readBody(req)).toString('utf8')) as {
          ids: string[]
        }
        const missing = await input.store.missing(body.ids)
        sendJson(res, 200, { missing })

        return
      }

      // POST /publish/commit  { package, target, commit, sig, key } -> { ok, ref }
      if (
        req.method === 'POST' &&
        parts[0] === 'publish' &&
        parts[1] === 'commit'
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

      // GET /resolve?package&ref -> { commit }
      if (req.method === 'GET' && parts[0] === 'resolve') {
        const pkg = url.searchParams.get('package')
        const ref = queryRef(url)

        if (!pkg || !ref) {
          sendJson(res, 400, { error: 'package and a ref are required' })

          return
        }

        const commit = await resolveRef({
          refs: input.refs,
          package: pkg,
          ref,
        })
        sendJson(res, 200, { commit })

        return
      }

      // GET /manifest?package&ref -> Manifest
      if (req.method === 'GET' && parts[0] === 'manifest') {
        const pkg = url.searchParams.get('package')
        const ref = queryRef(url)

        if (!pkg || !ref) {
          sendJson(res, 400, { error: 'package and a ref are required' })

          return
        }

        const commit = await resolveRef({
          refs: input.refs,
          package: pkg,
          ref,
        })
        const manifest = await buildManifest({
          commitId: commit,
          ref:
            ref.kind === 'version'
              ? ref.version
              : ref.kind === 'branch'
                ? ref.branch
                : ref.commit,
          store: input.store,
        })
        sendJson(res, 200, manifest)

        return
      }

      res.writeHead(404)
      res.end('not found')
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { error: message })
    }
  })
}
