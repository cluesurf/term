// Who may publish a scope, when the registry is a generic OCI registry that has never heard of Term.
//
// Our own server checked a publisher's key against a scope table. A container registry checks only that the
// pusher has write access to the repository, which says nothing about who SIGNED the bytes, and nothing at all once
// the artifact is copied to another registry. So the scope's key set is published as an artifact of its own, in
// the namespace repository, and the client checks every version against it:
//
//   ghcr.io/cluesurf/term:keys        the current key set of @term
//   ghcr.io/cluesurf/term:keys.<n>    every generation, kept tagged so a registry never collects one
//
// A key set is a sequence number, a list of ed25519 public keys and the digest of the generation before it, signed
// by a key of the PREVIOUS generation (the first generation signs itself). A client pins the generation it last
// accepted, per registry and scope, and accepts a newer one only when the chain of `previous` links reaches the
// pinned one with every step signed by the step before. So a registry, or whoever holds its write token, can serve
// the pinned set or a properly rotated one, and nothing else:
//
//   - an older generation is a rollback and is refused
//   - a set that does not chain to the pin is a replacement and is refused
//   - a version signed by a key outside the set is refused
//
// The first sight of a scope is trust on first use, the way SSH's known_hosts is. `TERM_TRUSTED_KEYS` pins a scope
// out of band (`@term=<key>,<key>;@other=<key>`), and a lockfile pins each package's key besides.

import fs from 'fs/promises'
import path from 'path'
import { randomUUID } from 'crypto'

import { signId, verifyId, type Keypair } from '../object/sign'
import { EMPTY_BYTES, EMPTY_DESCRIPTOR } from './artifact'
import { isDigest } from './reference'
import { MANIFEST_MEDIA_TYPE, OciError, sha256Digest, isDescriptor, type OciTransport } from './transport'

export const KEYS_ARTIFACT_TYPE = 'application/vnd.cluesurf.term.keys.v1'
export const KEYS_CONFIG_MEDIA_TYPE = 'application/vnd.cluesurf.term.keys.v1+json'
export const KEYS_TAG = 'keys'

const KEY = /^[A-Za-z0-9+/]{40,200}={0,2}$/

export type KeySet = {
  v: 1
  scope: string
  sequence: number
  keys: string[]
  previous: string | null
  // the key that signed this generation, which must be in the previous generation (or this one, for the first)
  signer: string
  sig: string
}

export type TrustedKeys = {
  keys: string[]
  // where the answer came from, for messages
  source: 'env' | 'pinned' | 'first-use' | 'rotated'
  sequence?: number
}

export function keySetStatement(set: Omit<KeySet, 'sig' | 'signer'>): string {
  return JSON.stringify({
    type: KEYS_ARTIFACT_TYPE,
    scope: set.scope,
    sequence: set.sequence,
    keys: [...set.keys].sort(),
    previous: set.previous,
  })
}

function parseKeySet(bytes: Buffer, scope: string): KeySet {
  let set: KeySet

  try {
    set = JSON.parse(bytes.toString('utf8')) as KeySet
  } catch {
    throw new OciError(`key set of ${scope} is not JSON`)
  }

  if (
    set.v !== 1 ||
    set.scope !== scope ||
    !Number.isSafeInteger(set.sequence) ||
    set.sequence < 1 ||
    !Array.isArray(set.keys) ||
    set.keys.length === 0 ||
    set.keys.length > 256 ||
    !set.keys.every(key => typeof key === 'string' && KEY.test(key)) ||
    !(set.previous === null || (typeof set.previous === 'string' && isDigest(set.previous))) ||
    (set.sequence === 1) !== (set.previous === null) ||
    typeof set.signer !== 'string' ||
    typeof set.sig !== 'string'
  ) {
    throw new OciError(`key set of ${scope} is malformed`)
  }

  return set
}

// A generation is signed by its signer, and the signer is one of `allowed`.
function signedBy(set: KeySet, allowed: string[]): boolean {
  return allowed.includes(set.signer) && verifyId({ id: keySetStatement(set), sig: set.sig, publicKey: set.signer })
}

type Fetched = { set: KeySet; digest: string }

async function fetchKeySet(input: { transport: OciTransport; repository: string; scope: string; reference: string }): Promise<Fetched | undefined> {
  const manifest = await input.transport.getManifest({ repository: input.repository, reference: input.reference })

  if (!manifest) {
    return undefined
  }

  const parsed = JSON.parse(manifest.bytes.toString('utf8')) as { artifactType?: string; config?: unknown }

  if (parsed.artifactType !== KEYS_ARTIFACT_TYPE || !isDescriptor(parsed.config) || parsed.config.mediaType !== KEYS_CONFIG_MEDIA_TYPE) {
    throw new OciError(`${input.repository}:${input.reference} is not a Term key set`)
  }

  const bytes = await input.transport.getBlob({ repository: input.repository, digest: parsed.config.digest, size: parsed.config.size, limit: 256 * 1024 })

  return { set: parseKeySet(bytes, input.scope), digest: manifest.digest }
}

function envKeys(scope: string, env: NodeJS.ProcessEnv): string[] | undefined {
  const raw = env['TERM_TRUSTED_KEYS']

  if (!raw) {
    return undefined
  }

  for (const part of raw.split(';')) {
    const eq = part.indexOf('=')

    if (eq > 0 && part.slice(0, eq).trim() === scope) {
      return part
        .slice(eq + 1)
        .split(',')
        .map(key => key.trim())
        .filter(key => KEY.test(key))
    }
  }

  return undefined
}

type Pin = { sequence: number; digest: string; keys: string[] }

function pinFile(input: { trustDir: string; host: string; repository: string; scope: string }): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9._-]/g, '_')

  return path.join(input.trustDir, safe(input.host), `${safe(input.repository)}.${safe(input.scope)}.json`)
}

async function readPin(file: string): Promise<Pin | undefined> {
  try {
    const pin = JSON.parse(await fs.readFile(file, 'utf8')) as Pin

    return Number.isSafeInteger(pin.sequence) && isDigest(pin.digest) && Array.isArray(pin.keys) ? pin : undefined
  } catch {
    return undefined
  }
}

async function writePin(file: string, pin: Pin): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${randomUUID()}`
  await fs.writeFile(tmp, JSON.stringify(pin, null, 2), { mode: 0o644 })
  await fs.rename(tmp, file)
}

/**
 * The keys allowed to sign packages of `scope`, or undefined when the scope publishes no key set. Verifies the
 * served generation against the pin and moves the pin forward along a verified rotation.
 */
export async function trustedKeys(input: {
  transport: OciTransport
  // the namespace repository the key set lives in: `cluesurf/term`
  repository: string
  scope: string
  host: string
  trustDir: string
  env?: NodeJS.ProcessEnv
}): Promise<TrustedKeys | undefined> {
  const fromEnv = envKeys(input.scope, input.env ?? process.env)

  if (fromEnv && fromEnv.length > 0) {
    return { keys: fromEnv, source: 'env' }
  }

  const served = await fetchKeySet({ ...input, reference: KEYS_TAG })
  const file = pinFile(input)
  const pin = await readPin(file)

  if (!served) {
    // a scope that once published a key set and now serves none has had it deleted: keep trusting the pin
    return pin ? { keys: pin.keys, source: 'pinned', sequence: pin.sequence } : undefined
  }

  // the generation must be signed by itself (the first) or be reachable by a verified chain
  const verifyStep = async (step: Fetched): Promise<Fetched | undefined> => {
    if (step.set.previous === null) {
      if (!signedBy(step.set, step.set.keys)) {
        throw new OciError(`the first key set of ${input.scope} is not signed by one of its own keys`)
      }

      return undefined
    }

    const before = await fetchKeySet({ ...input, reference: step.set.previous })

    if (!before) {
      throw new OciError(`key set ${step.set.sequence} of ${input.scope} names a previous generation the registry does not hold`)
    }

    if (before.set.sequence !== step.set.sequence - 1 || !signedBy(step.set, before.set.keys)) {
      throw new OciError(`key set ${step.set.sequence} of ${input.scope} is not signed by generation ${step.set.sequence - 1}`)
    }

    return before
  }

  if (!pin) {
    // first use: the served generation must still be internally sound, all the way back to the first
    let step: Fetched | undefined = served

    for (let hops = 0; step && hops < 10_000; hops += 1) {
      step = await verifyStep(step)
    }

    await writePin(file, { sequence: served.set.sequence, digest: served.digest, keys: served.set.keys })

    return { keys: served.set.keys, source: 'first-use', sequence: served.set.sequence }
  }

  if (served.digest === pin.digest) {
    return { keys: served.set.keys, source: 'pinned', sequence: pin.sequence }
  }

  if (served.set.sequence <= pin.sequence) {
    throw new OciError(
      `the registry serves key set ${served.set.sequence} of ${input.scope}, but generation ${pin.sequence} was already accepted: a rollback or a replaced key set`,
    )
  }

  // walk back from the served generation to the pinned one, every step verified
  let step: Fetched | undefined = served

  while (step && step.set.sequence > pin.sequence) {
    step = await verifyStep(step)
  }

  if (!step || step.digest !== pin.digest) {
    throw new OciError(`key set ${served.set.sequence} of ${input.scope} does not descend from the pinned generation ${pin.sequence}: the key set was replaced, not rotated`)
  }

  await writePin(file, { sequence: served.set.sequence, digest: served.digest, keys: served.set.keys })

  return { keys: served.set.keys, source: 'rotated', sequence: served.set.sequence }
}

async function pushKeySet(input: { transport: OciTransport; repository: string; set: KeySet }): Promise<string> {
  const bytes = Buffer.from(JSON.stringify(input.set))
  const config = { mediaType: KEYS_CONFIG_MEDIA_TYPE, digest: sha256Digest(bytes), size: bytes.length }

  await input.transport.putBlob({ repository: input.repository, digest: config.digest, bytes })
  await input.transport.putBlob({ repository: input.repository, digest: EMPTY_DESCRIPTOR.digest, bytes: EMPTY_BYTES })

  const manifest = Buffer.from(
    JSON.stringify({
      schemaVersion: 2,
      mediaType: MANIFEST_MEDIA_TYPE,
      artifactType: KEYS_ARTIFACT_TYPE,
      config,
      layers: [EMPTY_DESCRIPTOR],
      annotations: { 'org.opencontainers.image.title': `${input.set.scope} keys ${input.set.sequence}` },
    }),
  )

  // the numbered tag first, so the moving tag never names a generation that is not also kept
  const { digest } = await input.transport.putManifest({ repository: input.repository, reference: `${KEYS_TAG}.${input.set.sequence}`, bytes: manifest, mediaType: MANIFEST_MEDIA_TYPE })
  await input.transport.putManifest({ repository: input.repository, reference: KEYS_TAG, bytes: manifest, mediaType: MANIFEST_MEDIA_TYPE })

  return digest
}

/**
 * Make sure `keypair` may publish `scope`. A scope with no key set gets one, with this key as its only member. A
 * scope whose key set does not hold this key is refused, with the command a holder runs to add it.
 */
export async function ensurePublisher(input: {
  transport: OciTransport
  repository: string
  scope: string
  keypair: Keypair
}): Promise<{ created: boolean; sequence: number }> {
  const served = await fetchKeySet({ ...input, reference: KEYS_TAG })

  if (served) {
    if (!served.set.keys.includes(input.keypair.publicKey)) {
      throw new OciError(
        `this machine's key is not in the key set of ${input.scope} (generation ${served.set.sequence}). ` +
          `A holder of a key in the set adds it with: term host --trust ${input.keypair.publicKey}`,
      )
    }

    return { created: false, sequence: served.set.sequence }
  }

  const body = { v: 1 as const, scope: input.scope, sequence: 1, keys: [input.keypair.publicKey], previous: null }
  const set: KeySet = { ...body, signer: input.keypair.publicKey, sig: signId({ id: keySetStatement(body), privateKey: input.keypair.privateKey }) }

  await pushKeySet({ transport: input.transport, repository: input.repository, set })

  return { created: true, sequence: 1 }
}

/** Rotate a scope's key set: add and remove keys, signed by a key of the current generation. */
export async function rotateKeys(input: {
  transport: OciTransport
  repository: string
  scope: string
  keypair: Keypair
  add?: string[]
  remove?: string[]
}): Promise<{ sequence: number; keys: string[] }> {
  const served = await fetchKeySet({ ...input, reference: KEYS_TAG })

  if (!served) {
    throw new OciError(`${input.scope} has no key set yet. The first term host to it creates one`)
  }

  if (!served.set.keys.includes(input.keypair.publicKey)) {
    throw new OciError(`this machine's key is not in the key set of ${input.scope}, so it cannot rotate it`)
  }

  for (const key of input.add ?? []) {
    if (!KEY.test(key)) {
      throw new OciError(`not an ed25519 public key: ${key}`)
    }
  }

  const removed = new Set(input.remove ?? [])
  const keys = [...new Set([...served.set.keys, ...(input.add ?? [])])].filter(key => !removed.has(key)).sort()

  if (keys.length === 0) {
    throw new OciError(`refusing to leave ${input.scope} with no keys`)
  }

  const body = { v: 1 as const, scope: input.scope, sequence: served.set.sequence + 1, keys, previous: served.digest }
  const set: KeySet = { ...body, signer: input.keypair.publicKey, sig: signId({ id: keySetStatement(body), privateKey: input.keypair.privateKey }) }

  await pushKeySet({ transport: input.transport, repository: input.repository, set })

  return { sequence: set.sequence, keys }
}
