// The OCI Distribution API, the subset Term needs, as one interface with two implementations: a registry over
// HTTP (this file) and an OCI image layout on disk (`layout.ts`).
//
// Everything that crosses the wire is checked before it is believed:
//
//   - a blob or manifest is re-hashed on arrival and refused if its digest is not the one asked for
//   - every body is read against a size limit, so a hostile registry cannot exhaust memory with one response
//   - redirects are followed by hand, and the Authorization header never leaves the registry's own origin. A blob
//     GET answers 307 to a storage host, which must not receive the registry token
//   - a credential goes to a token realm only over https, unless the registry itself is plain http on loopback
//   - a repository, tag and digest is checked against the spec's grammar before it goes into a URL
//
// Only GET and HEAD are retried here, on a network failure, a 429 or a 5xx, honoring `Retry-After`. An upload is
// retried whole by `putBlob`, because a half-finished upload session cannot be resumed portably.

import { createHash } from 'crypto'

import { basicHeader, parseChallenge, type OciCredentials } from './auth'
import { assertDigest, assertTag, isDigest } from './reference'

export const MANIFEST_MEDIA_TYPE = 'application/vnd.oci.image.manifest.v1+json'
export const INDEX_MEDIA_TYPE = 'application/vnd.oci.image.index.v1+json'

const ACCEPT_MANIFEST = [
  MANIFEST_MEDIA_TYPE,
  INDEX_MEDIA_TYPE,
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ')

// The common registry limit on a manifest, and so the most any well-behaved registry will hand back.
export const MANIFEST_LIMIT = 4 * 1024 * 1024

// Above this a blob is uploaded in PATCH chunks rather than one PUT.
const DEFAULT_CHUNK_SIZE = 16 * 1024 * 1024

const MAX_REDIRECTS = 5

export type Descriptor = {
  mediaType: string
  digest: string
  size: number
  artifactType?: string
  annotations?: Record<string, string>
}

export type FetchedManifest = {
  digest: string
  mediaType: string
  bytes: Buffer
}

export type BlobOutcome = 'present' | 'mounted' | 'uploaded'

/** What a Term client needs from a registry, whether it is a server or a directory. */
export type OciTransport = {
  // for messages: `ghcr.io`, `layout:/path`
  label: string
  hasBlob(input: { repository: string; digest: string }): Promise<boolean>
  getBlob(input: { repository: string; digest: string; size?: number; limit: number }): Promise<Buffer>
  putBlob(input: {
    repository: string
    digest: string
    bytes: Buffer
    // a repository on the same registry already holding the blob, mounted instead of uploaded
    mountFrom?: string
  }): Promise<BlobOutcome>
  /** A manifest by tag or digest, verified against the digest when one was asked for, or undefined on 404. */
  getManifest(input: { repository: string; reference: string }): Promise<FetchedManifest | undefined>
  putManifest(input: {
    repository: string
    reference: string
    bytes: Buffer
    mediaType: string
  }): Promise<{ digest: string; subjectAccepted: boolean }>
  listTags(input: { repository: string }): Promise<string[]>
  /** The referrers of a manifest, or undefined when the registry has no referrers API. */
  referrers(input: { repository: string; digest: string; artifactType?: string }): Promise<Descriptor[] | undefined>
}

export class OciError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message)
    this.name = 'OciError'
  }
}

export function sha256Digest(bytes: Buffer | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`
}

/** Refuse bytes whose digest is not the one they were asked for. */
export function verifyDigest(input: { digest: string; bytes: Buffer; what: string }): void {
  const actual = sha256Digest(input.bytes)

  if (actual !== input.digest) {
    throw new OciError(`${input.what} failed verification: asked for ${input.digest}, received ${actual}`)
  }
}

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function isLoopback(host: string): boolean {
  const bare = host.replace(/:\d+$/, '').replace(/^\[|\]$/g, '')

  return bare === 'localhost' || bare === '::1' || /^127\.\d+\.\d+\.\d+$/.test(bare)
}

// `TERM_OCI_INSECURE=host1,host2` names the non-loopback hosts that may be spoken to over plain http.
function insecureHosts(env: NodeJS.ProcessEnv): Set<string> {
  return new Set(
    (env['TERM_OCI_INSECURE'] ?? '')
      .split(',')
      .map(host => host.trim().toLowerCase())
      .filter(Boolean),
  )
}

type Fetch = typeof fetch

type RequestInit = {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH'
  headers?: Record<string, string>
  body?: Buffer
  // the repository actions the request needs a token for
  scope?: string[]
}

type TokenEntry = { header: string; expires: number }

/**
 * An OCI registry over HTTP. `credentials` is looked up once, lazily, the first time a registry asks for them, so
 * an anonymous pull from a public registry never reads the docker config at all.
 */
export function httpTransport(input: {
  host: string
  credentials?: () => Promise<OciCredentials | undefined>
  insecure?: boolean
  fetch?: Fetch
  chunkSize?: number
  retries?: number
  env?: NodeJS.ProcessEnv
}): OciTransport {
  const env = input.env ?? process.env
  const host = input.host.toLowerCase()
  const plain = input.insecure ?? (isLoopback(host) || insecureHosts(env).has(host))
  const base = `${plain ? 'http' : 'https'}://${host}`
  const origin = new URL(base).origin
  const doFetch: Fetch = input.fetch ?? fetch
  const chunkSize = input.chunkSize ?? DEFAULT_CHUNK_SIZE
  const retries = input.retries ?? 4
  const tokens = new Map<string, TokenEntry>()
  let credentials: Promise<OciCredentials | undefined> | undefined

  const loadCredentials = (): Promise<OciCredentials | undefined> => {
    credentials ??= input.credentials?.() ?? Promise.resolve(undefined)

    return credentials
  }

  const scopeKey = (scope: string[] | undefined): string => (scope ?? []).slice().sort().join(' ')

  // Trade credentials for a token at the realm a challenge named.
  const fetchToken = async (challenge: { realm: string; service?: string }, scope: string[]): Promise<TokenEntry> => {
    const realm = new URL(challenge.realm)

    if (realm.protocol !== 'https:' && !(realm.protocol === 'http:' && plain)) {
      throw new OciError(`token realm ${realm.origin} is not https, refusing to send credentials to it`)
    }

    const creds = await loadCredentials()
    const headers: Record<string, string> = { 'user-agent': 'term' }
    let response: Response

    if (creds?.kind === 'identity') {
      const form = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: creds.token, client_id: 'term' })

      if (challenge.service) {
        form.set('service', challenge.service)
      }

      if (scope.length > 0) {
        form.set('scope', scope.join(' '))
      }

      response = await doFetch(realm, {
        method: 'POST',
        headers: { ...headers, 'content-type': 'application/x-www-form-urlencoded' },
        body: form.toString(),
        redirect: 'error',
      })
    } else {
      if (challenge.service) {
        realm.searchParams.set('service', challenge.service)
      }

      for (const entry of scope) {
        realm.searchParams.append('scope', entry)
      }

      if (creds?.kind === 'basic') {
        headers['authorization'] = basicHeader(creds)
      }

      response = await doFetch(realm, { method: 'GET', headers, redirect: 'error' })
    }

    if (!response.ok) {
      throw new OciError(`token request to ${realm.origin} failed: ${response.status}${await errorText(response)}`, response.status)
    }

    const body = JSON.parse((await readLimited(response, 1024 * 1024)).toString('utf8')) as {
      token?: string
      access_token?: string
      expires_in?: number
    }
    const token = body.token ?? body.access_token

    if (!token) {
      throw new OciError(`token response from ${realm.origin} held no token`)
    }

    const life = Math.max(30, Math.min(body.expires_in ?? 60, 3600))

    return { header: `Bearer ${token}`, expires: Date.now() + (life - 10) * 1000 }
  }

  const authorize = async (response: Response, scope: string[]): Promise<boolean> => {
    const challenge = parseChallenge(response.headers.get('www-authenticate'))

    if (!challenge) {
      return false
    }

    if (challenge.scheme === 'basic') {
      const creds = await loadCredentials()

      if (creds?.kind !== 'basic') {
        return false
      }

      if (!plain || isLoopback(host)) {
        tokens.set(scopeKey(scope), { header: basicHeader(creds), expires: Number.POSITIVE_INFINITY })

        return true
      }

      return false
    }

    if (!challenge.realm) {
      return false
    }

    tokens.set(scopeKey(scope), await fetchToken({ realm: challenge.realm, service: challenge.service }, scope))

    return true
  }

  // One request, authorized, redirects followed by hand. The Authorization header is attached only for the
  // registry's own origin, so a 307 to blob storage reaches it without the token.
  const send = async (target: string | URL, init: RequestInit): Promise<Response> => {
    let url = new URL(target, base)
    let authorized = false

    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const headers: Record<string, string> = { 'user-agent': 'term', ...init.headers }

      if (url.origin === origin) {
        const entry = tokens.get(scopeKey(init.scope))

        if (entry && entry.expires > Date.now()) {
          headers['authorization'] = entry.header
        }
      }

      const response = await doFetch(url, {
        method: init.method,
        headers,
        // a Buffer from a pooled allocation can be detached mid-request by undici, so send a copy
        body: init.body === undefined ? undefined : new Blob([new Uint8Array(init.body)]),
        redirect: 'manual',
      })

      if (response.status === 401 && url.origin === origin && !authorized) {
        await response.body?.cancel()
        authorized = true

        if (await authorize(response, init.scope ?? [])) {
          hop -= 1
          continue
        }

        return response
      }

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get('location')
        await response.body?.cancel()

        if (!location) {
          throw new OciError(`${init.method} ${url.pathname} redirected with no location`)
        }

        const next = new URL(location, url)

        if (next.protocol !== 'https:' && next.protocol !== 'http:') {
          throw new OciError(`refusing a redirect to ${next.protocol}`)
        }

        // never downgrade an https request to http
        if (url.protocol === 'https:' && next.protocol === 'http:') {
          throw new OciError(`refusing a redirect from https to http (${next.origin})`)
        }

        url = next
        continue
      }

      return response
    }

    throw new OciError(`too many redirects for ${init.method} ${new URL(target, base).pathname}`)
  }

  // GET and HEAD, retried on what is worth retrying.
  const sendIdempotent = async (target: string, init: RequestInit): Promise<Response> => {
    let lastError: unknown

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const response = await send(target, init)

        if (response.status !== 429 && response.status < 500) {
          return response
        }

        if (attempt === retries) {
          return response
        }

        await response.body?.cancel()
        await sleep(backoff(attempt, response.headers.get('retry-after')))
      } catch (error) {
        if (error instanceof OciError || attempt === retries) {
          throw error
        }

        lastError = error
        await sleep(backoff(attempt, null))
      }
    }

    throw lastError
  }

  const repoPath = (repository: string, rest: string): string => {
    assertRepository(repository)

    return `/v2/${repository}/${rest}`
  }

  const pull = (repository: string): string[] => [`repository:${repository}:pull`]
  const push = (repository: string): string[] => [`repository:${repository}:pull,push`]

  const hasBlob = async (args: { repository: string; digest: string }): Promise<boolean> => {
    assertDigest(args.digest)
    const response = await sendIdempotent(repoPath(args.repository, `blobs/${args.digest}`), {
      method: 'HEAD',
      scope: pull(args.repository),
    })

    await response.body?.cancel()

    if (response.status === 200) {
      return true
    }

    if (response.status === 404) {
      return false
    }

    throw new OciError(`HEAD blob ${args.digest} on ${host}/${args.repository}: ${response.status}`, response.status)
  }

  const uploadOnce = async (args: { repository: string; digest: string; bytes: Buffer; mountFrom?: string }): Promise<BlobOutcome> => {
    const scope = args.mountFrom ? [...push(args.repository), ...pull(args.mountFrom)] : push(args.repository)
    const start = new URL(repoPath(args.repository, 'blobs/uploads/'), base)

    if (args.mountFrom) {
      assertRepository(args.mountFrom)
      start.searchParams.set('mount', args.digest)
      start.searchParams.set('from', args.mountFrom)
    }

    // an empty body rather than none, so the request carries `content-length: 0`, which some registries require
    const opened = await send(start, { method: 'POST', scope, body: Buffer.alloc(0) })

    if (opened.status === 201 && args.mountFrom) {
      await opened.body?.cancel()

      return 'mounted'
    }

    if (opened.status !== 202) {
      throw new OciError(`start upload of ${args.digest} to ${host}/${args.repository}: ${opened.status}${await errorText(opened)}`, opened.status)
    }

    await opened.body?.cancel()
    let location = uploadLocation(opened, base)

    if (args.bytes.length > chunkSize) {
      for (let at = 0; at < args.bytes.length; at += chunkSize) {
        const part = args.bytes.subarray(at, Math.min(at + chunkSize, args.bytes.length))
        const patched = await send(location, {
          method: 'PATCH',
          scope,
          body: part,
          headers: {
            'content-type': 'application/octet-stream',
            'content-range': `${at}-${at + part.length - 1}`,
          },
        })

        if (patched.status !== 202) {
          throw new OciError(`upload chunk at ${at} of ${args.digest}: ${patched.status}${await errorText(patched)}`, patched.status)
        }

        await patched.body?.cancel()
        location = uploadLocation(patched, base)
      }
    }

    const finish = new URL(location)
    finish.searchParams.set('digest', args.digest)
    const whole = args.bytes.length <= chunkSize
    const closed = await send(finish, {
      method: 'PUT',
      scope,
      body: whole ? args.bytes : Buffer.alloc(0),
      headers: { 'content-type': 'application/octet-stream' },
    })

    if (closed.status !== 201 && closed.status !== 204) {
      throw new OciError(`finish upload of ${args.digest}: ${closed.status}${await errorText(closed)}`, closed.status)
    }

    await closed.body?.cancel()

    return 'uploaded'
  }

  return {
    label: host,

    hasBlob,

    async getBlob(args) {
      assertDigest(args.digest)
      const limit = args.size === undefined ? args.limit : Math.min(args.limit, args.size)
      const response = await sendIdempotent(repoPath(args.repository, `blobs/${args.digest}`), {
        method: 'GET',
        scope: pull(args.repository),
      })

      if (!response.ok) {
        throw new OciError(`GET blob ${args.digest} from ${host}/${args.repository}: ${response.status}${await errorText(response)}`, response.status)
      }

      const bytes = await readLimited(response, limit)

      if (args.size !== undefined && bytes.length !== args.size) {
        throw new OciError(`blob ${args.digest} is ${bytes.length} bytes, its descriptor says ${args.size}`)
      }

      verifyDigest({ digest: args.digest, bytes, what: `blob ${args.digest}` })

      return bytes
    },

    async putBlob(args) {
      assertDigest(args.digest)
      verifyDigest({ digest: args.digest, bytes: args.bytes, what: `upload of ${args.digest}` })

      if (await hasBlob(args)) {
        return 'present'
      }

      let lastError: unknown

      for (let attempt = 0; attempt <= retries; attempt += 1) {
        try {
          return await uploadOnce(args)
        } catch (error) {
          lastError = error

          // a 4xx other than 429 is an answer, not a hiccup
          if (error instanceof OciError && error.status !== undefined && error.status < 500 && error.status !== 429) {
            throw error
          }

          if (attempt < retries) {
            await sleep(backoff(attempt, null))
          }
        }
      }

      throw lastError
    },

    async getManifest(args) {
      if (!isDigest(args.reference)) {
        assertTag(args.reference)
      }

      const response = await sendIdempotent(repoPath(args.repository, `manifests/${args.reference}`), {
        method: 'GET',
        scope: pull(args.repository),
        headers: { accept: ACCEPT_MANIFEST },
      })

      if (response.status === 404) {
        await response.body?.cancel()

        return undefined
      }

      if (!response.ok) {
        throw new OciError(`GET manifest ${args.repository}:${args.reference} from ${host}: ${response.status}${await errorText(response)}`, response.status)
      }

      const bytes = await readLimited(response, MANIFEST_LIMIT)
      const digest = sha256Digest(bytes)

      if (isDigest(args.reference) && digest !== args.reference) {
        throw new OciError(`manifest ${args.reference} failed verification: received ${digest}`)
      }

      // the server's own statement of the digest, when it makes one, must agree with the bytes
      const stated = response.headers.get('docker-content-digest')

      if (stated && stated.startsWith('sha256:') && stated !== digest) {
        throw new OciError(`manifest ${args.repository}:${args.reference} is ${digest}, the registry says ${stated}`)
      }

      return { digest, mediaType: manifestMediaType(bytes, response.headers.get('content-type')), bytes }
    },

    async putManifest(args) {
      if (!isDigest(args.reference)) {
        assertTag(args.reference)
      }

      if (args.bytes.length > MANIFEST_LIMIT) {
        throw new OciError(`manifest is ${args.bytes.length} bytes, over the ${MANIFEST_LIMIT} byte limit registries enforce`)
      }

      const digest = sha256Digest(args.bytes)
      const response = await send(repoPath(args.repository, `manifests/${args.reference}`), {
        method: 'PUT',
        scope: push(args.repository),
        body: args.bytes,
        headers: { 'content-type': args.mediaType },
      })

      if (response.status !== 201 && response.status !== 200 && response.status !== 202) {
        throw new OciError(`PUT manifest ${args.repository}:${args.reference} to ${host}: ${response.status}${await errorText(response)}`, response.status)
      }

      await response.body?.cancel()
      const stated = response.headers.get('docker-content-digest')

      if (stated && stated.startsWith('sha256:') && stated !== digest) {
        throw new OciError(`registry stored manifest as ${stated}, expected ${digest}`)
      }

      return { digest, subjectAccepted: response.headers.has('oci-subject') }
    },

    async listTags(args) {
      const tags: string[] = []
      let next: string | undefined = `${repoPath(args.repository, 'tags/list')}?n=1000`

      for (let page = 0; next && page < 10_000; page += 1) {
        const response = await sendIdempotent(next, { method: 'GET', scope: pull(args.repository) })

        if (response.status === 404) {
          await response.body?.cancel()

          return tags
        }

        if (!response.ok) {
          throw new OciError(`list tags of ${host}/${args.repository}: ${response.status}${await errorText(response)}`, response.status)
        }

        const body = JSON.parse((await readLimited(response, 16 * 1024 * 1024)).toString('utf8')) as { tags?: string[] | null }

        for (const tag of body.tags ?? []) {
          if (typeof tag === 'string' && /^[a-zA-Z0-9_][a-zA-Z0-9._-]{0,127}$/.test(tag)) {
            tags.push(tag)
          }
        }

        next = nextLink(response.headers.get('link'), origin)
      }

      return tags
    },

    async referrers(args) {
      assertDigest(args.digest)
      const out: Descriptor[] = []
      const first = new URL(repoPath(args.repository, `referrers/${args.digest}`), base)

      if (args.artifactType) {
        first.searchParams.set('artifactType', args.artifactType)
      }

      let next: string | undefined = first.pathname + first.search

      for (let page = 0; next && page < 1000; page += 1) {
        const response = await sendIdempotent(next, {
          method: 'GET',
          scope: pull(args.repository),
          headers: { accept: INDEX_MEDIA_TYPE },
        })

        if (response.status === 404) {
          await response.body?.cancel()

          // 404 on the first page means the API is not there. A registry with the API answers 200 and an empty list
          return page === 0 ? undefined : out
        }

        if (!response.ok) {
          throw new OciError(`referrers of ${args.digest} on ${host}/${args.repository}: ${response.status}${await errorText(response)}`, response.status)
        }

        const index = JSON.parse((await readLimited(response, MANIFEST_LIMIT)).toString('utf8')) as { manifests?: Descriptor[] }
        out.push(...(index.manifests ?? []).filter(isDescriptor))
        next = nextLink(response.headers.get('link'), origin)
      }

      return args.artifactType ? out.filter(entry => entry.artifactType === args.artifactType) : out
    },
  }
}

const REPOSITORY = /^[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*(\/[a-z0-9]+((\.|_|__|-+)[a-z0-9]+)*)*$/

export function assertRepository(repository: string): void {
  if (!REPOSITORY.test(repository) || repository.length > 255) {
    throw new OciError(`not an OCI repository name: ${repository}`)
  }
}

export function isDescriptor(value: unknown): value is Descriptor {
  const entry = value as Descriptor

  return (
    typeof entry === 'object' &&
    entry !== null &&
    typeof entry.mediaType === 'string' &&
    typeof entry.digest === 'string' &&
    isDigest(entry.digest) &&
    Number.isSafeInteger(entry.size) &&
    entry.size >= 0
  )
}

function manifestMediaType(bytes: Buffer, header: string | null): string {
  try {
    const parsed = JSON.parse(bytes.toString('utf8')) as { mediaType?: string }

    if (typeof parsed.mediaType === 'string') {
      return parsed.mediaType
    }
  } catch {
    // not JSON: the caller's parse will say so
  }

  return header?.split(';')[0]?.trim() || MANIFEST_MEDIA_TYPE
}

// A `Link: </v2/x/tags/list?n=1000&last=y>; rel="next"` header, kept only when it stays on the registry.
function nextLink(header: string | null, origin: string): string | undefined {
  if (!header) {
    return undefined
  }

  const match = /<([^>]+)>\s*;\s*rel="?next"?/i.exec(header)

  if (!match) {
    return undefined
  }

  const url = new URL(match[1]!, origin)

  return url.origin === origin ? url.pathname + url.search : undefined
}

function uploadLocation(response: Response, base: string): string {
  const location = response.headers.get('location')

  if (!location) {
    throw new OciError('upload session answered with no location')
  }

  const url = new URL(location, base)

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OciError(`upload location has scheme ${url.protocol}`)
  }

  if (new URL(base).protocol === 'https:' && url.protocol === 'http:') {
    throw new OciError('upload location downgrades https to http')
  }

  return url.toString()
}

function backoff(attempt: number, retryAfter: string | null): number {
  const stated = retryAfter ? Number(retryAfter) : Number.NaN

  if (Number.isFinite(stated) && stated >= 0) {
    return Math.min(stated * 1000, 30_000)
  }

  return Math.min(250 * 2 ** attempt, 8_000) + Math.floor(Math.random() * 100)
}

/** Read a response body, refusing it the moment it passes `limit` bytes. */
export async function readLimited(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'))

  if (Number.isFinite(declared) && declared > limit) {
    await response.body?.cancel()
    throw new OciError(`response of ${declared} bytes is over the ${limit} byte limit`)
  }

  if (!response.body) {
    return Buffer.alloc(0)
  }

  const reader = response.body.getReader()
  const parts: Uint8Array[] = []
  let total = 0

  for (;;) {
    const { done, value } = await reader.read()

    if (done) {
      break
    }

    total += value.length

    if (total > limit) {
      await reader.cancel()
      throw new OciError(`response passed the ${limit} byte limit`)
    }

    parts.push(value)
  }

  return Buffer.concat(parts, total)
}

// The registry's error body, `{"errors":[{"code","message"}]}`, short, for a message. Never throws.
async function errorText(response: Response): Promise<string> {
  try {
    const text = (await readLimited(response, 64 * 1024)).toString('utf8')
    const parsed = JSON.parse(text) as { errors?: { code?: string; message?: string }[] }
    const first = parsed.errors?.[0]

    if (first) {
      return ` ${first.code ?? ''}${first.message ? `: ${first.message}` : ''}`.slice(0, 300)
    }

    return text ? ` ${text.slice(0, 300)}` : ''
  } catch {
    return ''
  }
}
