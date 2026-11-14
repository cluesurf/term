// A FACE (term-cli-in-term-0115): transport.ts's exports in their shapes, answered by registry-transport.tree. It turns
// the port's oci-failure carrier (decision 007) into the original class, reading which value is one, its message and
// status by oci-failure.tree's tasks (decision 153 rule 3). Original: tmp/retired/make/deck-oci-transport.
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

/** Every method of a host record a port made (a transport, an object store), its oci-failure seen as an OciError. */
export function liftRecord<T extends object>(made: T): T {
  const out: Record<string, unknown> = {}
  for (const [name, value] of Object.entries(made)) {
    const call = value as (...a: unknown[]) => unknown
    out[name] =
      typeof value === 'function'
        ? (...args: unknown[]) => liftAsync(async () => call(...args))
        : value
  }
  return out as T
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

export const readLimited = (
  response: Response,
  limit: number,
): Promise<Buffer> =>
  liftAsync(() => p.readLimited!(response, limit) as Promise<Buffer>)

export function httpTransport(input: {
  host: string
  credentials?: () => Promise<OciCredentials | undefined>
  insecure?: boolean
  fetch?: typeof fetch
  chunkSize?: number
  monolithic?: number
  retries?: number
  env?: NodeJS.ProcessEnv
}): OciTransport {
  const made = lift(
    () =>
      p.httpTransport!(
        input.host,
        input.credentials,
        input.insecure,
        input.fetch,
        input.chunkSize,
        input.monolithic,
        input.retries,
        input.env,
      ) as OciTransport,
  )
  return liftRecord(made)
}
