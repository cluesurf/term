// Remote compile cache (Tier 5). The local `.base/@cluesurf/term/cache` is content-addressed, so it shares across
// machines / CI with a trivial protocol: GET an index, GET / PUT an artifact by `<kind>/<version>/<key>`. Because the
// in-process CacheStore is synchronous and HTTP is not, the remote cache is a warm-before / push-after step around
// the build (not a per-key fetch): `pull` downloads missing artifacts into the local dir before compiling, `push`
// uploads new local artifacts after. Content addressing makes both safe (a key's bytes never change).
// See note/research/repo/turborepo/04-remote-cache.md.
//
// THE VERSION IS PART OF THE ADDRESS because it is part of the local layout, and this module does not get to have
// its own opinion about that layout. It used to list `<kind>/*.json` and write back to the same flat path, which
// worked until the store changed shape on 2026-09-01 and then pushed and pulled ZERO artifacts, silently, with its
// own tests reporting `pushed 0`. Paths come from `entryPath` and the index from `storedEntries`, both in
// cache-store.ts, so there is one implementation of where an entry lives.
//
// The bytes moved are the STORED bytes, gzip and all, so a transfer costs what the entry costs on disk (about a
// thirteenth of the JSON) and neither side has to re-compress.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import path from 'path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { entryPathBySlug, storedEntries } from '@term/call/code/cache-store'

const KINDS = ['mill', 'output'] as const
type Kind = (typeof KINDS)[number]

// an entry's address: its kind, the compiler-version namespace it belongs to, and its key
type Address = { kind: Kind; version: string; key: string }


function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

// the artifacts present in a local cache dir, with the version namespace each one sits in
function localEntries(cacheDir: string): Address[] {
  return storedEntries(cacheDir, KINDS).map(entry => ({
    kind: entry.kind as Kind,
    version: entry.version,
    key: entry.key,
  }))
}

function idOf(entry: Address): string {
  return `${entry.kind}/${entry.version}/${entry.key}`
}

// download every remote artifact the local cache is missing, into `cacheDir`. Returns how many were pulled.
export async function pullRemoteCache(
  cacheDir: string,
  endpoint: string,
  token?: string,
): Promise<number> {
  const indexResponse = await fetch(`${endpoint}/index`, {
    headers: authHeaders(token),
  })

  if (!indexResponse.ok) {
    return 0
  }

  const remote = (await indexResponse.json()) as Address[]
  const have = new Set(localEntries(cacheDir).map(idOf))

  let pulled = 0

  for (const entry of remote) {
    if (have.has(idOf(entry))) {
      continue
    }

    const response = await fetch(`${endpoint}/${idOf(entry)}`, {
      headers: authHeaders(token),
    })

    if (!response.ok) {
      continue
    }

    const file = entryPathBySlug(cacheDir, entry.kind, entry.version, entry.key)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(await response.arrayBuffer()))
    pulled += 1
  }

  return pulled
}

// upload every local artifact the remote is missing. Returns how many were pushed.
export async function pushRemoteCache(
  cacheDir: string,
  endpoint: string,
  token?: string,
): Promise<number> {
  const indexResponse = await fetch(`${endpoint}/index`, {
    headers: authHeaders(token),
  })

  const remote = indexResponse.ok
    ? ((await indexResponse.json()) as Address[])
    : []

  const have = new Set(remote.map(idOf))

  let pushed = 0

  for (const entry of localEntries(cacheDir)) {
    if (have.has(idOf(entry))) {
      continue
    }

    const body = readFileSync(
      entryPathBySlug(cacheDir, entry.kind, entry.version, entry.key),
    )

    const response = await fetch(`${endpoint}/${idOf(entry)}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/octet-stream',
        ...authHeaders(token),
      },
      body,
    })

    if (response.ok) {
      pushed += 1
    }
  }

  return pushed
}

export interface RemoteCacheServer {
  port: number
  close(): void
}

// a minimal remote cache server: stores artifacts on disk under `storeDir`, exposes the GET-index / GET / PUT protocol
// the client speaks. An optional bearer token gates writes (and reads). For self-hosting a team / CI cache.
export function startRemoteCacheServer(options: {
  storeDir: string
  port: number
  token?: string
}): RemoteCacheServer {
  const { storeDir, port, token } = options
  const app = new Hono()

  const authed = (context: {
    req: { header: (n: string) => string | undefined }
  }): boolean =>
    !token || context.req.header('authorization') === `Bearer ${token}`

  app.get('/index', context => {
    if (!authed(context)) {
      return context.text('unauthorized', 401)
    }

    return context.json(localEntries(storeDir))
  })

  app.get('/:kind/:version/:key', context => {
    if (!authed(context)) {
      return context.text('unauthorized', 401)
    }

    const { kind, version, key } = context.req.param()

    if (kind !== 'mill' && kind !== 'output') {
      return context.text('bad kind', 400)
    }

    const file = entryPathBySlug(storeDir, kind, version, key)

    if (!existsSync(file)) {
      return context.text('miss', 404)
    }

    return context.body(readFileSync(file), 200, {
      'content-type': 'application/octet-stream',
    })
  })

  app.put('/:kind/:version/:key', async context => {
    if (!authed(context)) {
      return context.text('unauthorized', 401)
    }

    const { kind, version, key } = context.req.param()

    if (kind !== 'mill' && kind !== 'output') {
      return context.text('bad kind', 400)
    }

    const file = entryPathBySlug(storeDir, kind, version, key)
    mkdirSync(path.dirname(file), { recursive: true })
    writeFileSync(file, Buffer.from(await context.req.arrayBuffer()))

    return context.json({ ok: true })
  })

  const server = serve({ fetch: app.fetch, port })

  return { port, close: () => server.close() }
}
