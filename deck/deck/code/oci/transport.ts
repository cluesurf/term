// A FACE (term-cli-in-term-0115): transport.ts's exports in their shapes, answered by registry-transport.tree. It turns
// the port's oci-failure carrier (decision 007) into the original class, reading which value is one, its message and
// status by oci-failure.tree's tasks (decision 153 rule 3). Original: tmp/retired/make/deck-oci-transport. The shapes
// convert both ways (ruling term-self-host-001-1613): a transport's maybe answers are unboxed on the way out
// (liftRecord), and a transport handed back into a port is the port's own again on the way in (portTransport).
import * as port from '@term/deck/code/oci/registry-transport'
import type { OciCredentials } from './auth'

const p = port as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>

export const MANIFEST_MEDIA_TYPE = p.manifestMediaType!() as string
export const INDEX_MEDIA_TYPE = p.indexMediaType!() as string
export const MANIFEST_LIMIT = p.manifestLimit!() as number

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

type In<T> = { repository: string } & T

export type OciTransport = {
  label: string
  hasBlob(input: In<{ digest: string }>): Promise<boolean>
  getBlob(
    input: In<{ digest: string; size?: number; limit: number }>,
  ): Promise<Buffer>
  putBlob(
    input: In<{ digest: string; bytes: Buffer; mountFrom?: string }>,
  ): Promise<BlobOutcome>
  getManifest(
    input: In<{ reference: string }>,
  ): Promise<FetchedManifest | undefined>
  putManifest(
    input: In<{ reference: string; bytes: Buffer; mediaType: string }>,
  ): Promise<{ digest: string; subjectAccepted: boolean }>
  listTags(input: { repository: string }): Promise<string[]>
  referrers(
    input: In<{ digest: string; artifactType?: string }>,
  ): Promise<Descriptor[] | undefined>
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

/** The port's oci-failure carrier as the original's class (status -1 as none); anything else as it is. */
export function ociErrorOf(error: unknown): unknown {
  if (!p.isOciFailure!(error)) return error
  const status = p.ociFailureStatus!(error) as number
  const message = p.ociFailureMessage!(error) as string
  return new OciError(message, status === -1 ? undefined : status)
}

export function lift<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

export async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

// the methods of the port's oci-transport that answer a maybe (decision 176 rule 2, item term-self-host-001-1582)
const MAYBE_METHODS = new Set(['getManifest', 'referrers'])

// each lifted record and the port's own record it stands over, so a lifted transport handed back into a port is the
// port's again (portTransport, ruling term-self-host-001-1613)
const PORT_RECORDS = new WeakMap<object, object>()

type Box = { form: 'some'; value: unknown } | { form: 'none' }

const isBox = (value: unknown): value is Box =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  ((value as { form?: unknown }).form === 'some' ||
    (value as { form?: unknown }).form === 'none')

/** A maybe the port answered, as the original's value or undefined. */
const unboxed = (value: unknown): unknown =>
  isBox(value) ? (value.form === 'some' ? value.value : undefined) : value

/**
 * Every method of a host record a port made (a transport, an object store), its oci-failure seen as an OciError, and
 * a transport's maybe answers (get-manifest, referrers) unboxed to the record or undefined (decision 153).
 */
export function liftRecord<T extends object>(made: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(made)) {
    const call = value as (...a: unknown[]) => unknown
    const unboxes = MAYBE_METHODS.has(name)
    out[name] =
      typeof value === 'function'
        ? (...args: unknown[]) =>
            liftAsync(async () => {
              const answer = await call(...args)
              return unboxes ? unboxed(answer) : answer
            })
        : value
  }
  PORT_RECORDS.set(out, made)
  return out as T
}

/**
 * A transport a TypeScript caller hands into a port, as the port takes it: the port's own record behind a lifted one,
 * or, for a transport a caller made itself, the same methods with get-manifest's and referrers' answers boxed as the
 * port's maybe (none for undefined). Every face that passes a transport into a port calls it (ruling 1613).
 */
export function portTransport<T>(transport: T): T {
  if (typeof transport !== 'object' || transport === null) return transport
  const own = PORT_RECORDS.get(transport)
  if (own) return own as T
  return new Proxy(transport as object, {
    get(target, name, receiver) {
      const value: unknown = Reflect.get(target, name, receiver)
      if (typeof name !== 'string' || !MAYBE_METHODS.has(name)) return value
      if (typeof value !== 'function') return value
      return async (...args: unknown[]): Promise<Box> => {
        const answer: unknown = await value.apply(target, args)
        if (isBox(answer)) return answer
        // the readers this replaced tested the answer for truth, so a hand-made null is none as undefined is
        return answer === undefined || answer === null
          ? { form: 'none' }
          : { form: 'some', value: answer }
      }
    },
  }) as T
}

export const sha256Digest = (bytes: Buffer | Uint8Array): string =>
  p.sha256Digest!(bytes) as string

export const verifyDigest = (input: {
  digest: string
  bytes: Buffer
  what: string
}): void => {
  lift(() => p.verifyDigest!(input.digest, input.bytes, input.what))
}

export const assertRepository = (repository: string): void =>
  lift(() => p.assertRepository!(repository) as void)

export const isDescriptor = (value: unknown): value is Descriptor =>
  p.isDescriptor!(value) as boolean

/** The front a registry host is spoken to over, `http://<host>` or `https://<host>` (decision 179 rule 2). */
export const registryFront = (input: {
  host: string
  insecure?: boolean
  env?: NodeJS.ProcessEnv
}): string =>
  p.registryFront!(input.host, boxed(input.insecure), boxed(input.env)) as string

export function httpTransport(input: {
  host: string
  credentials?: () => Promise<OciCredentials | undefined>
  insecure?: boolean
  chunkSize?: number
  monolithic?: number
  retries?: number
  env?: NodeJS.ProcessEnv
}): OciTransport {
  // no credentials asks for none, as the original's `asker?.() ?? undefined`
  const credentials = input.credentials ?? (async () => undefined)
  const made = lift(
    () =>
      p.httpTransport!(
        input.host,
        credentials,
        boxed(input.insecure),
        boxed(input.chunkSize),
        boxed(input.monolithic),
        boxed(input.retries),
        boxed(input.env),
      ) as OciTransport,
  )
  return liftRecord(made)
}

/** A value the port takes as a maybe (decision 176 rule 1): some when the caller set it, none when it is undefined. */
function boxed<T>(
  value: T | undefined,
): { form: 'some'; value: T } | { form: 'none' } {
  return value === undefined ? { form: 'none' } : { form: 'some', value }
}
