// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/transport.ts's exports, with
// their shapes, answered by deck/deck/code/oci/registry-transport.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-transport.
// The port raises oci-failure (decision 007); this face maps that carrier back to the original class, so a TypeScript
// caller that tests `instanceof OciError` or reads `.status` and `.message` sees what it saw, until the TypeScript
// callers (call/code, task/, the deck's tests) move to the form.
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

export type OciTransport = {
  label: string
  hasBlob(input: {
    repository: string
    digest: string
  }): Promise<boolean>
  getBlob(input: {
    repository: string
    digest: string
    size?: number
    limit: number
  }): Promise<Buffer>
  putBlob(input: {
    repository: string
    digest: string
    bytes: Buffer
    mountFrom?: string
  }): Promise<BlobOutcome>
  getManifest(input: {
    repository: string
    reference: string
  }): Promise<FetchedManifest | undefined>
  putManifest(input: {
    repository: string
    reference: string
    bytes: Buffer
    mediaType: string
  }): Promise<{ digest: string; subjectAccepted: boolean }>
  listTags(input: { repository: string }): Promise<string[]>
  referrers(input: {
    repository: string
    digest: string
    artifactType?: string
  }): Promise<Descriptor[] | undefined>
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

/** The port's oci-failure carrier as the original's class; anything else as it is. */
export function ociErrorOf(error: unknown): unknown {
  const caught = error as {
    form?: unknown
    link?: { thing?: unknown; status?: unknown }
  } | null

  if (
    caught !== null &&
    typeof caught === 'object' &&
    caught.form === 'oci-failure'
  ) {
    const status = caught.link?.status

    return new OciError(
      String(caught.link?.thing ?? ''),
      typeof status === 'number' ? status : undefined,
    )
  }

  return error
}

function lift<T>(work: () => T): T {
  try {
    return work()
  } catch (error) {
    throw ociErrorOf(error)
  }
}

async function liftAsync<T>(work: () => Promise<T>): Promise<T> {
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
    out[name] =
      typeof value === 'function'
        ? async (...args: unknown[]) => {
            try {
              return await (value as (...a: unknown[]) => unknown)(
                ...args,
              )
            } catch (error) {
              throw ociErrorOf(error)
            }
          }
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
}): void =>
  lift(
    () =>
      p.verifyDigest!(input.digest, input.bytes, input.what) as void,
  )

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

  return {
    label: made.label,
    hasBlob: asked => liftAsync(() => made.hasBlob(asked)),
    getBlob: asked => liftAsync(() => made.getBlob(asked)),
    putBlob: asked => liftAsync(() => made.putBlob(asked)),
    getManifest: asked => liftAsync(() => made.getManifest(asked)),
    putManifest: asked => liftAsync(() => made.putManifest(asked)),
    listTags: asked => liftAsync(() => made.listTags(asked)),
    referrers: asked => liftAsync(() => made.referrers(asked)),
  }
}
