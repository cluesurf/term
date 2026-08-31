// Remote compile cache (Tier 5). The local `.base/@cluesurf/term/cache` is content-addressed, so it shares across machines / CI with
// a trivial protocol: GET an index of keys, GET / PUT an artifact by `<kind>/<key>`. Because the in-process CacheStore
// is synchronous and HTTP is not, the remote cache is a warm-before / push-after step around the build (not a per-key
// fetch): `pull` downloads missing artifacts into the local dir before compiling, `push` uploads new local artifacts
// after. Content addressing makes both safe (a key's bytes never change). See note/research/repo/turborepo/04-remote-cache.md.

import {
  readdirSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
  existsSync,
} from 'fs'
import path from 'path'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

const KINDS = ['mill', 'output'] as const
type Kind = (typeof KINDS)[number]

function authHeaders(token?: string): Record<string, string> {
  return token ? { authorization: `Bearer ${token}` } : {}
}

// the (kind, key) artifacts present in a local cache dir
function localEntries(cacheDir: string): { kind: Kind; key: string }[] {
  const entries: { kind: Kind; key: string }[] = []

  for (const kind of KINDS) {
    const dir = path.join(cacheDir, kind)

    if (!existsSync(dir)) {
      continue
    }

    for (const file of readdirSync(dir)) {
      if (file.endsWith('.json')) {
        entries.push({ kind, key: file.slice(0, -'.json'.length) })
      }
    }
  }

  return entries
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

  const remote = (await indexResponse.json()) as {
    kind: Kind
    key: string
  }[]

  const have = new Set(
    localEntries(cacheDir).map(e => `${e.kind}/${e.key}`),
  )

  let pulled = 0

  for (const { kind, key } of remote) {
    if (have.has(`${kind}/${key}`)) {
      continue
    }

    const response = await fetch(`${endpoint}/${kind}/${key}`, {
      headers: authHeaders(token),
    })

    if (!response.ok) {
      continue
    }

    mkdirSync(path.join(cacheDir, kind), { recursive: true })
    writeFileSync(
      path.join(cacheDir, kind, `${key}.json`),
      await response.text(),
    )
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
    ? ((await indexResponse.json()) as {
        kind: Kind
        key: string
      }[])
    : []

  const have = new Set(remote.map(e => `${e.kind}/${e.key}`))

  let pushed = 0

  for (const { kind, key } of localEntries(cacheDir)) {
    if (have.has(`${kind}/${key}`)) {
      continue
    }

    const body = readFileSync(
      path.join(cacheDir, kind, `${key}.json`),
      'utf8',
    )

    const response = await fetch(`${endpoint}/${kind}/${key}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
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

  app.get('/:kind/:key', context => {
    if (!authed(context)) {
      return context.text('unauthorized', 401)
    }

    const { kind, key } = context.req.param()

    if (kind !== 'mill' && kind !== 'output') {
      return context.text('bad kind', 400)
    }

    const file = path.join(storeDir, kind, `${key}.json`)

    if (!existsSync(file)) {
      return context.text('miss', 404)
    }

    return context.body(readFileSync(file, 'utf8'), 200, {
      'content-type': 'application/json',
    })
  })

  app.put('/:kind/:key', async context => {
    if (!authed(context)) {
      return context.text('unauthorized', 401)
    }

    const { kind, key } = context.req.param()

    if (kind !== 'mill' && kind !== 'output') {
      return context.text('bad kind', 400)
    }

    const dir = path.join(storeDir, kind)
    mkdirSync(dir, { recursive: true })
    writeFileSync(
      path.join(dir, `${key}.json`),
      await context.req.text(),
    )

    return context.json({ ok: true })
  })

  const server = serve({ fetch: app.fetch, port })

  return { port, close: () => server.close() }
}
