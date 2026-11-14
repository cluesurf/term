// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/publish.ts's exports, with
// their shapes, answered by deck/deck/code/oci/oci-publishing.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-publish.
// Artifact format v2 (decision 129 section 2 of the self-host change, decisions 154 and 158, item
// term-self-host-001-1043): a publish target is a version, no branch, commit, object store or signature referrer.
import * as port from '@term/deck/code/oci/oci-publishing'
import {
  ociErrorOf,
  type Descriptor,
  type OciTransport,
} from './transport'
import type { ArchiveEntry, BuiltArtifact, DeckLinkEntry } from './artifact'
import type { Keypair } from '../object/sign'

const p = port as unknown as Record<
  string,
  (...args: unknown[]) => unknown
>

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

type Target = { kind: 'version'; version: string }

export type OciPublishResult = {
  digest: string
  reference: string
  tag: string
  unchanged: boolean
  blobs: {
    total: number
    uploaded: number
    mounted: number
    present: number
  }
  bytes: { total: number; uploaded: number }
  layers: number
  manifestSize: number
  keySet: 'created' | 'member'
  artifact: BuiltArtifact
}

type ArtifactInput = {
  dir: string
  package: string
  version: string
  link: DeckLinkEntry[]
  keypair: Keypair
  annotations?: Record<string, string>
  include?: string[]
}

// the tag a publish target is written under. A target is a version, nothing else (decision 154 section 1)
export const tagOfTarget = (target: Target): string =>
  lift(() => p.tagOfTarget!(target) as string)

// the artifact a publish would push, built without contacting anything (`term host --dry`)
export const buildOciArtifact = (
  input: ArtifactInput,
): Promise<{ entries: ArchiveEntry[]; artifact: BuiltArtifact }> =>
  liftAsync(
    async () =>
      p.buildOciArtifact!(
        input.dir,
        input.package,
        input.version,
        input.link,
        input.keypair,
        input.annotations,
        input.include,
      ) as { entries: ArchiveEntry[]; artifact: BuiltArtifact },
  )

export const publishToOci = (
  input: ArtifactInput & {
    transport: OciTransport
    repository: { host: string; namespace: string; name: string }
    scope: string
    keysRepository: string
    concurrency?: number
    log?: (message: string) => void
  },
): Promise<OciPublishResult> =>
  liftAsync(
    () =>
      p.publishToOci!(
        input.dir,
        input.package,
        input.version,
        input.link,
        input.transport,
        input.repository,
        input.scope,
        input.keysRepository,
        input.keypair,
        input.annotations,
        input.include,
        input.concurrency,
        input.log,
      ) as Promise<OciPublishResult>,
  )

// OWED, not a shape: deck/deck/code/index.ts (decision 153, its last importers waiting on 1044 and 1278) still
// re-exports this name. The signature referrer is not part of v2 (decision 158 rule 3), so it always refuses
export const attachSignature = (_input: {
  transport: OciTransport
  repository: string
  subject: Descriptor
  artifact: BuiltArtifact
}): Promise<never> =>
  liftAsync(async () => {
    throw new Error(
      'the signature referrer is not part of OCI artifact format v2 (decision 158 rule 3)',
    )
  })
