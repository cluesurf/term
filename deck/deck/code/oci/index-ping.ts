// Tell the package index a version exists (note/term/registry/19).
//
// After a successful push, `term host` posts the pinned reference to the index. The index fetches and verifies the
// artifact from the registry itself, so the reference alone carries no trust and needs no account. It is a HINT: the
// index's periodic crawl finds what a lost ping missed, so a failed ping is a warning and never a failed publish.
//
// A term.surf token ATTRIBUTES the version. With one (`TERM_TOKEN`, or the `auth` file under
// `~/.base/@cluesurf/term/`, made at term.surf/settings/tokens with the `package:publish` scope), the ping carries it as
// `Authorization: Bearer` and adds a claim signed by the key that signed the version:
// `term.publish.v1 <reference> <time>`. The index binds that key to the token's account, which is how a version is
// credited to a person. The token goes to the index and NEVER to a registry: registry credentials are a separate
// thing (oci/auth.ts), and the bytes are pushed with those alone.
//
// Sent only for a registry the index can read, a public one, so a private mirror or a localhost registry never
// announces itself. `TERM_INDEX=0` turns it off, and `TERM_INDEX_URL` points it elsewhere. A token is sent only over
// https, or to a loopback index for a test.

import { KEYS_REPOSITORY } from './client'
import type { OciRepository } from './reference'
import { signId, type Keypair } from '../object/sign'

const DEFAULT_INDEX_URL = 'https://tool.term.surf'

// Where a token is made, named in the message when the index refuses one
const TOKEN_PAGE = 'https://term.surf/settings/tokens'

// The hosts the index reads from, the same list as `REGISTRIES` in the index's own reader
const INDEXED_HOSTS = new Set(['ghcr.io'])

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])

const PING_TIMEOUT_MS = 10_000

// where GHCR hands out pull tokens. Anonymous, it answers only for a public package
const GHCR_TOKEN_URL = 'https://ghcr.io/token'

export type IndexPing =
  // `publisher` is the account the version was credited to, when a token was sent and accepted
  | { form: 'sent'; outcome: string; publisher?: string }
  | { form: 'skipped'; reason: string }
  | { form: 'failed'; reason: string }

/** The statement a publisher claim signs, byte for byte the index's `publishStatement`. */
export function publishStatement(input: { reference: string; time: string }): string {
  return `term.publish.v1 ${input.reference} ${input.time}`
}

export async function pingIndex(input: {
  repository: OciRepository
  digest: string
  // a term.surf token with `package:publish`, to be credited for the version. Without one the ping is anonymous
  token?: string
  // the key that signed the version, which signs the claim. Needed only beside a token
  keypair?: Keypair
  env?: NodeJS.ProcessEnv
  fetch?: typeof fetch
  now?: () => Date
}): Promise<IndexPing> {
  const env = input.env ?? process.env

  if (env['TERM_INDEX'] === '0') {
    return { form: 'skipped', reason: 'TERM_INDEX=0' }
  }

  if (!INDEXED_HOSTS.has(input.repository.host) && !env['TERM_INDEX_URL']) {
    return { form: 'skipped', reason: `${input.repository.host} is not a registry the index reads` }
  }

  const base = (env['TERM_INDEX_URL']?.trim() || DEFAULT_INDEX_URL).replace(/\/+$/, '')
  const reference = `oci://${input.repository.host}/${input.repository.name}@${input.digest}`

  // the index reads the artifact anonymously, so a private package is refused there whatever this sends. Asked here
  // first, so the message names the one fix rather than a status code
  const hidden = await privateOnGhcr({ repository: input.repository, fetch: input.fetch ?? fetch })

  if (hidden) {
    return { form: 'failed', reason: hidden }
  }
  const token = input.token?.trim()
  const headers: Record<string, string> = { 'content-type': 'application/json', 'user-agent': 'term' }
  const body: Record<string, string> = { reference }

  if (token) {
    if (!input.keypair) {
      return { form: 'failed', reason: 'a term.surf token was given without the signing key that proves the claim' }
    }

    if (!isSafeForToken(base)) {
      return { form: 'failed', reason: `${base} is not https, so the term.surf token was not sent` }
    }

    const time = (input.now ?? (() => new Date()))().toISOString()
    headers['authorization'] = `Bearer ${token}`
    body['time'] = time
    body['key'] = input.keypair.publicKey
    body['sig'] = signId({ id: publishStatement({ reference, time }), privateKey: input.keypair.privateKey })
  }

  try {
    const response = await (input.fetch ?? fetch)(`${base}/packages/publish!`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(PING_TIMEOUT_MS),
    })

    if (response.status === 401 && token) {
      return {
        form: 'failed',
        reason: `${base} refused the term.surf token. It is revoked, expired, or lacks package:publish. Make one at ${TOKEN_PAGE}`,
      }
    }

    if (response.status === 403 && token) {
      return { form: 'failed', reason: `${base} refused the claim: this machine's key did not sign that version` }
    }

    if (response.status === 409) {
      return {
        form: 'failed',
        reason: `409 from ${base}: the version is indexed under another digest, its scope is reserved by another namespace, or this machine's signing key is bound to another term.surf account`,
      }
    }

    if (!response.ok) {
      return { form: 'failed', reason: await refusalOf({ response, base }) }
    }

    const answer = (await response.json().catch(() => ({}))) as {
      base?: { outcome?: string; publisher?: { id?: string } }
      outcome?: string
      publisher?: { id?: string }
    }
    const publisher = answer.base?.publisher?.id ?? answer.publisher?.id

    return {
      form: 'sent',
      outcome: answer.base?.outcome ?? answer.outcome ?? 'published',
      ...(publisher ? { publisher } : {}),
    }
  } catch (error) {
    return { form: 'failed', reason: (error as Error).message }
  }
}

// Whether the GHCR packages the index reads are still private: the version's own repository AND the scope's key set
// (`<namespace>/name`), a separate package the index reads to check the signer. GHCR hands an anonymous pull token
// only for a public package. A NEW PACKAGE ON GHCR IS ALWAYS PRIVATE, and GitHub has no API to change that (its
// packages API lists, reads, deletes and restores, and nothing else), so the one fix is a click in each package's
// settings, once and for good, since a public package cannot be made private again. The key set missed this check at
// first and the ping failed on it AFTER the package was made public. Returns the message naming every page to visit,
// or undefined when both are public or the question could not be asked (the ping then answers for itself).
async function privateOnGhcr(input: { repository: OciRepository; fetch: typeof fetch }): Promise<string | undefined> {
  if (input.repository.host !== 'ghcr.io') {
    return undefined
  }

  const keys = input.repository.namespace ? `${input.repository.namespace}/${KEYS_REPOSITORY}` : KEYS_REPOSITORY
  const hidden: string[] = []

  for (const name of [input.repository.name, keys]) {
    if (await isPrivateOnGhcr({ name, fetch: input.fetch })) {
      hidden.push(name)
    }
  }

  if (hidden.length === 0) {
    return undefined
  }

  const pages = hidden.map(name => {
    const [owner, ...rest] = name.split('/')

    return `ghcr.io/${name} at https://github.com/orgs/${owner}/packages/container/${encodeURIComponent(rest.join('/'))}/settings`
  })

  return `the index cannot read a private package. Make ${hidden.length === 1 ? 'it' : 'each'} public once (Danger Zone, Change visibility; it cannot be made private again), then run term host --ping: ${pages.join(', and ')}`
}

// One GHCR repository: true when an anonymous pull token is refused. False when granted, and false when the question
// could not be asked, so a network failure never invents a visibility problem
async function isPrivateOnGhcr(input: { name: string; fetch: typeof fetch }): Promise<boolean> {
  try {
    const url = new URL(GHCR_TOKEN_URL)

    url.searchParams.set('scope', `repository:${input.name}:pull`)
    url.searchParams.set('service', 'ghcr.io')

    const response = await input.fetch(url.toString(), { signal: AbortSignal.timeout(PING_TIMEOUT_MS) })

    return response.status === 401 || response.status === 403
  } catch {
    return false
  }
}

// Why the index refused, in its own words. A bare `400 from <index>` hid a private GHCR package for a whole publish:
// the index said `an anonymous pull token, which a public package grants` and nobody saw it. The index answers
// `{ note, link: { field, expected } }`, and the `expected` is the part a person can act on
async function refusalOf(input: { response: Response; base: string }): Promise<string> {
  const answer = (await input.response.json().catch(() => ({}))) as {
    note?: string
    link?: { field?: string; value?: string; expected?: string }
  }
  const expected = answer.link?.expected
  const field = answer.link?.field

  if (expected) {
    return `${input.response.status} from ${input.base}: the ${field ?? 'request'} needs ${expected}`
  }

  return answer.note ? `${input.response.status} from ${input.base}: ${answer.note}` : `${input.response.status} from ${input.base}`
}

// A bearer token travels only over https, or to a loopback index (a test, or a local API)
function isSafeForToken(base: string): boolean {
  try {
    const url = new URL(base)

    return url.protocol === 'https:' || (url.protocol === 'http:' && LOOPBACK.has(url.hostname))
  } catch {
    return false
  }
}
