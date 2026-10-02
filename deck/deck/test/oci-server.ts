// An in-process OCI Distribution registry for the OCI client tests: the subset a registry like zot or GHCR serves,
// with the behaviors that make a client get things wrong.
//
//   - every /v2 request needs a bearer token, got from /token after a `WWW-Authenticate` challenge. A pull may be
//     anonymous; a push needs Basic credentials at the token endpoint
//   - a blob GET answers 307 to a SECOND server, the "storage" host, which records whether an Authorization header
//     reached it. A client that forwards the registry token across origins is caught there
//   - uploads: POST, then PATCH chunks with Content-Range, then PUT ?digest, which the server verifies; and
//     cross-repository mounts
//   - tags are paged with `n` and `last` and a Link header
//   - the referrers API, which `referrers: false` turns off to exercise the fallback tag
//
// It also lets a test reach in and misbehave: overwrite a stored blob, or retag a manifest.

import http from 'http'
import { createHash, randomUUID } from 'crypto'
import type { AddressInfo } from 'net'

export type OciServer = {
  host: string
  close(): Promise<void>
  blobs: Map<string, Buffer>
  // repository -> tag -> digest
  tags: Map<string, Map<string, string>>
  manifests: Map<string, { bytes: Buffer; mediaType: string }>
  requests: { method: string; path: string }[]
  // Authorization headers that reached the storage host. Must stay empty
  leakedAuth: string[]
  tamperBlob(digest: string, bytes: Buffer): void
  retag(input: { repository: string; tag: string; digest: string }): void
}

const sha = (bytes: Buffer): string => `sha256:${createHash('sha256').update(bytes).digest('hex')}`

async function body(request: http.IncomingMessage): Promise<Buffer> {
  const parts: Buffer[] = []

  for await (const part of request) {
    parts.push(part as Buffer)
  }

  return Buffer.concat(parts)
}

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port))
  })
}

export async function startOciServer(options?: {
  username?: string
  password?: string
  referrers?: boolean
  pageSize?: number
}): Promise<OciServer> {
  const username = options?.username ?? 'tester'
  const password = options?.password ?? 'secret'
  const blobs = new Map<string, Buffer>()
  const tags = new Map<string, Map<string, string>>()
  const manifests = new Map<string, { bytes: Buffer; mediaType: string }>()
  const uploads = new Map<string, { repository: string; parts: Buffer[] }>()
  const repoBlobs = new Map<string, Set<string>>()
  const issued = new Map<string, { push: boolean }>()
  const requests: { method: string; path: string }[] = []
  const leakedAuth: string[] = []

  const storage = http.createServer((request, response) => {
    if (request.headers.authorization) {
      leakedAuth.push(request.headers.authorization)
    }

    const digest = decodeURIComponent((request.url ?? '').slice(1))
    const bytes = blobs.get(digest)

    if (!bytes) {
      response.writeHead(404).end()

      return
    }

    response.writeHead(200, { 'content-length': String(bytes.length), 'content-type': 'application/octet-stream' }).end(bytes)
  })

  const storagePort = await listen(storage)
  // `localhost` rather than 127.0.0.1, so storage is a different origin from the registry
  const storageBase = `http://localhost:${storagePort}`

  let registryBase = ''

  const holds = (repository: string): Set<string> => {
    let set = repoBlobs.get(repository)

    if (!set) {
      set = new Set()
      repoBlobs.set(repository, set)
    }

    return set
  }

  const challenge = (response: http.ServerResponse, scope: string): void => {
    response
      .writeHead(401, {
        'www-authenticate': `Bearer realm="${registryBase}/token",service="test-registry",scope="${scope}"`,
        'content-type': 'application/json',
      })
      .end(JSON.stringify({ errors: [{ code: 'UNAUTHORIZED', message: 'authentication required' }] }))
  }

  const fail = (response: http.ServerResponse, status: number, code: string): void => {
    response.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ errors: [{ code, message: code.toLowerCase() }] }))
  }

  const registry = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? '/', registryBase)
    requests.push({ method: request.method ?? '', path: url.pathname + url.search })

    if (url.pathname === '/token') {
      const scopes = url.searchParams.getAll('scope')
      const wantsPush = scopes.some(scope => /:[^:]*push/.test(scope))
      const auth = request.headers.authorization
      const good = auth === `Basic ${Buffer.from(`${username}:${password}`).toString('base64')}`

      if (auth && !good) {
        fail(response, 401, 'UNAUTHORIZED')

        return
      }

      if (wantsPush && !good) {
        fail(response, 401, 'DENIED')

        return
      }

      const token = randomUUID()
      issued.set(token, { push: good })
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ token, expires_in: 300 }))

      return
    }

    const match = /^\/v2\/(.+?)\/(blobs\/uploads\/?.*|blobs\/[^/]+|manifests\/[^/]+|tags\/list|referrers\/[^/]+)$/.exec(url.pathname)

    if (!match) {
      fail(response, 404, 'NAME_UNKNOWN')

      return
    }

    const repository = match[1]!
    const rest = match[2]!
    const writing = request.method === 'POST' || request.method === 'PUT' || request.method === 'PATCH'
    const scope = `repository:${repository}:${writing ? 'pull,push' : 'pull'}`
    const bearer = /^Bearer (.+)$/.exec(request.headers.authorization ?? '')?.[1]
    const grant = bearer ? issued.get(bearer) : undefined

    if (!grant || (writing && !grant.push)) {
      await body(request)
      challenge(response, scope)

      return
    }

    // ---- blob uploads ----
    if (rest.startsWith('blobs/uploads')) {
      const id = rest.slice('blobs/uploads/'.length)

      if (request.method === 'POST') {
        await body(request)
        const mount = url.searchParams.get('mount')
        const from = url.searchParams.get('from')

        if (mount && from && repoBlobs.get(from)?.has(mount)) {
          holds(repository).add(mount)
          response.writeHead(201, { location: `/v2/${repository}/blobs/${mount}`, 'docker-content-digest': mount }).end()

          return
        }

        const session = randomUUID()
        uploads.set(session, { repository, parts: [] })
        response.writeHead(202, { location: `/v2/${repository}/blobs/uploads/${session}`, range: '0-0' }).end()

        return
      }

      const upload = uploads.get(id)

      if (!upload || upload.repository !== repository) {
        await body(request)
        fail(response, 404, 'BLOB_UPLOAD_UNKNOWN')

        return
      }

      if (request.method === 'PATCH') {
        const part = await body(request)
        const range = request.headers['content-range']
        const offset = upload.parts.reduce((sum, chunk) => sum + chunk.length, 0)

        if (range && range !== `${offset}-${offset + part.length - 1}`) {
          fail(response, 416, 'RANGE_INVALID')

          return
        }

        upload.parts.push(part)
        const total = offset + part.length
        response.writeHead(202, { location: `/v2/${repository}/blobs/uploads/${id}`, range: `0-${total - 1}` }).end()

        return
      }

      if (request.method === 'PUT') {
        upload.parts.push(await body(request))
        const bytes = Buffer.concat(upload.parts)
        const digest = url.searchParams.get('digest')
        uploads.delete(id)

        if (digest !== sha(bytes)) {
          fail(response, 400, 'DIGEST_INVALID')

          return
        }

        blobs.set(digest, bytes)
        holds(repository).add(digest)
        response.writeHead(201, { location: `/v2/${repository}/blobs/${digest}`, 'docker-content-digest': digest }).end()

        return
      }
    }

    // ---- blobs ----
    if (rest.startsWith('blobs/')) {
      const digest = rest.slice('blobs/'.length)

      if (!holds(repository).has(digest) || !blobs.has(digest)) {
        fail(response, 404, 'BLOB_UNKNOWN')

        return
      }

      if (request.method === 'HEAD') {
        response.writeHead(200, { 'content-length': String(blobs.get(digest)!.length), 'docker-content-digest': digest }).end()

        return
      }

      response.writeHead(307, { location: `${storageBase}/${encodeURIComponent(digest)}` }).end()

      return
    }

    // ---- manifests ----
    if (rest.startsWith('manifests/')) {
      const reference = rest.slice('manifests/'.length)
      const repoTags = tags.get(repository) ?? new Map<string, string>()

      if (request.method === 'PUT') {
        const bytes = await body(request)
        const digest = sha(bytes)
        const parsed = JSON.parse(bytes.toString('utf8')) as {
          config?: { digest: string }
          layers?: { digest: string }[]
          manifests?: { digest: string }[]
          subject?: { digest: string }
        }

        // a registry refuses a manifest whose blobs it does not hold in this repository
        for (const desc of [parsed.config, ...(parsed.layers ?? [])].filter(Boolean)) {
          if (!holds(repository).has(desc!.digest)) {
            fail(response, 400, 'MANIFEST_BLOB_UNKNOWN')

            return
          }
        }

        if (reference.startsWith('sha256:') && reference !== digest) {
          fail(response, 400, 'DIGEST_INVALID')

          return
        }

        manifests.set(digest, { bytes, mediaType: String(request.headers['content-type'] ?? '') })
        holds(repository).add(digest)

        if (!reference.startsWith('sha256:')) {
          repoTags.set(reference, digest)
          tags.set(repository, repoTags)
        }

        const headers: Record<string, string> = { location: `/v2/${repository}/manifests/${digest}`, 'docker-content-digest': digest }

        if (parsed.subject && options?.referrers !== false) {
          headers['oci-subject'] = parsed.subject.digest
        }

        response.writeHead(201, headers).end()

        return
      }

      const digest = reference.startsWith('sha256:') ? reference : repoTags.get(reference)
      const stored = digest && holds(repository).has(digest) ? manifests.get(digest) : undefined

      if (!stored) {
        fail(response, 404, 'MANIFEST_UNKNOWN')

        return
      }

      const headers = { 'content-type': stored.mediaType, 'docker-content-digest': digest!, 'content-length': String(stored.bytes.length) }

      if (request.method === 'HEAD') {
        response.writeHead(200, headers).end()

        return
      }

      response.writeHead(200, headers).end(stored.bytes)

      return
    }

    // ---- tags ----
    if (rest === 'tags/list') {
      const all = [...(tags.get(repository)?.keys() ?? [])].sort()

      if (all.length === 0 && !repoBlobs.has(repository)) {
        fail(response, 404, 'NAME_UNKNOWN')

        return
      }

      const n = Math.min(Number(url.searchParams.get('n') ?? 1000), options?.pageSize ?? 1000)
      const last = url.searchParams.get('last')
      const after = last ? all.filter(tag => tag > last) : all
      const page = after.slice(0, n)
      const headers: Record<string, string> = { 'content-type': 'application/json' }

      if (after.length > n) {
        headers['link'] = `</v2/${repository}/tags/list?n=${n}&last=${encodeURIComponent(page.at(-1)!)}>; rel="next"`
      }

      response.writeHead(200, headers).end(JSON.stringify({ name: repository, tags: page }))

      return
    }

    // ---- referrers ----
    if (rest.startsWith('referrers/')) {
      if (options?.referrers === false) {
        fail(response, 404, 'NAME_UNKNOWN')

        return
      }

      const subject = rest.slice('referrers/'.length)
      const wanted = url.searchParams.get('artifactType')
      const found: unknown[] = []

      for (const digest of holds(repository)) {
        const stored = manifests.get(digest)

        if (!stored) {
          continue
        }

        const parsed = JSON.parse(stored.bytes.toString('utf8')) as { subject?: { digest: string }; artifactType?: string; mediaType: string }

        if (parsed.subject?.digest === subject && (!wanted || parsed.artifactType === wanted)) {
          found.push({ mediaType: parsed.mediaType, digest, size: stored.bytes.length, artifactType: parsed.artifactType })
        }
      }

      response
        .writeHead(200, { 'content-type': 'application/vnd.oci.image.index.v1+json' })
        .end(JSON.stringify({ schemaVersion: 2, mediaType: 'application/vnd.oci.image.index.v1+json', manifests: found }))

      return
    }

    fail(response, 405, 'UNSUPPORTED')
  })

  const port = await listen(registry)
  registryBase = `http://127.0.0.1:${port}`

  return {
    host: `127.0.0.1:${port}`,
    blobs,
    tags,
    manifests,
    requests,
    leakedAuth,
    tamperBlob(digest, bytes) {
      blobs.set(digest, bytes)
    },
    retag(input) {
      const repoTags = tags.get(input.repository) ?? new Map<string, string>()
      repoTags.set(input.tag, input.digest)
      tags.set(input.repository, repoTags)
    },
    close: () =>
      new Promise(resolve => {
        registry.closeAllConnections()
        storage.closeAllConnections()
        registry.close(() => storage.close(() => resolve()))
      }),
  }
}
