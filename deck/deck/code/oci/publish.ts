// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/publish.ts's exports, with
// their shapes, answered by deck/deck/code/oci/oci-publishing.tree. The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-publish.
import * as port from '@term/deck/code/oci/oci-publishing'
import { ociErrorOf, type Descriptor, type OciTransport } from './transport'
import type { Keypair } from '../object/sign'


const p = port as unknown as Record<string, (...args: unknown[]) => unknown>

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

type Target = { kind: 'version'; version: string } | { kind: 'branch'; branch: string; expected?: string | null }
type Artifact = any

export type OciPublishResult = {
  digest: string
  reference: string
  tag: string
  unchanged: boolean
  blobs: { total: number; uploaded: number; mounted: number; present: number }
  bytes: { total: number; uploaded: number }
  layers: number
  manifestSize: number
  keySet: 'created' | 'member'
  referrer: 'attached' | 'fallback-tag' | 'failed' | 'skipped'
  artifact: Artifact
}

type ArtifactInput = {
  dir: string
  package: string
  version: string
  target: Target
  link: unknown[]
  local: unknown
  keypair: Keypair
  author: string
  time: string
  message?: string
  params?: unknown
  annotations?: Record<string, string>
  include?: string[]
}

export const tagOfTarget = (target: Target): string => lift(() => p.tagOfTarget!(target) as string)

export const buildOciArtifact = (input: ArtifactInput): Promise<{ release: any; artifact: Artifact }> =>
  liftAsync(
    () =>
      p.buildOciArtifact!(
        input.dir,
        input.package,
        input.version,
        input.target,
        input.link,
        input.local,
        input.keypair,
        input.author,
        input.time,
        input.message,
        input.params,
        input.annotations,
        input.include,
      ) as Promise<{ release: any; artifact: Artifact }>,
  )

export const publishToOci = (
  input: ArtifactInput & {
    transport: OciTransport
    repository: { host: string; namespace: string; name: string }
    scope: string
    keysRepository: string
    concurrency?: number
    referrer?: boolean
    log?: (message: string) => void
  },
): Promise<OciPublishResult> =>
  liftAsync(
    () =>
      p.publishToOci!(
        input.dir,
        input.package,
        input.version,
        input.target,
        input.link,
        input.transport,
        input.repository,
        input.scope,
        input.keysRepository,
        input.local,
        input.keypair,
        input.author,
        input.time,
        input.message,
        input.params,
        input.annotations,
        input.include,
        input.concurrency,
        input.referrer,
        input.log,
      ) as Promise<OciPublishResult>,
  )

export const attachSignature = (input: { transport: OciTransport; repository: string; subject: Descriptor; artifact: Artifact }): Promise<'attached' | 'fallback-tag'> =>
  liftAsync(() => p.attachSignature!(input.transport, input.repository, input.subject, input.artifact) as Promise<'attached' | 'fallback-tag'>)
