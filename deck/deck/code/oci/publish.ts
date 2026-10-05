// `term host` to an OCI registry.
//
//   1. build the release locally, as every publish does
//   2. build the artifact: the whole closure packed by content, so an unchanged run of objects packs to a blob the
//      registry already holds under the same digest
//   3. make sure this key may publish the scope (creating the scope's key set on its first publish)
//   4. refuse a version tag that already names a different manifest. Versions are write-once
//   5. upload each blob the registry lacks, found by HEAD, a few at a time
//   6. put the manifest under its tag, then read the tag back to catch a racing publish
//   7. ONLY WHEN ASKED (`referrer: true`): attach the signature as an OCI 1.1 referrer, so tooling that has never
//      heard of Term (`oras discover`) can see it
//
// THE REFERRER IS OFF BY DEFAULT since 2026-10-04. The signature that is checked lives in the config, and nothing
// that installs reads the referrer. On a registry without the referrers API, GHCR among them, the spec's fallback is
// an index TAGGED `sha256-<hex of the version's digest>`, and GHCR lists that tag beside every real version, so each
// release looked like two. The ORAS interop witness (task/term/oci-witness.ts) is what asks for it.
//
// Nothing is uploaded on a dry run, and nothing reaches the registry before the artifact has passed the closure rule.

import { buildRelease, type Release } from '../object/release'
import type { ObjectStore } from '../object/store'
import type { Keypair } from '../object/sign'
import type { ChunkParams } from '../object/chunk'
import type { PublishTarget } from '../object/registry'
import {
  buildArtifact,
  buildSignatureReferrer,
  COMMIT_ANNOTATION,
  EMPTY_BYTES,
  EMPTY_DESCRIPTOR,
  SIGNATURE_ARTIFACT_TYPE,
  type BuiltArtifact,
  type DeckLinkEntry,
} from './artifact'
import { ensurePublisher } from './keys'
import { pinnedReference, tagOfVersion, assertTag, type OciRepository } from './reference'
import {
  INDEX_MEDIA_TYPE,
  MANIFEST_MEDIA_TYPE,
  OciError,
  sha256Digest,
  type BlobOutcome,
  type Descriptor,
  type OciTransport,
} from './transport'

export type OciPublishResult = {
  digest: string
  reference: string
  tag: string
  // nothing moved: the tag already named this exact manifest
  unchanged: boolean
  blobs: { total: number; uploaded: number; mounted: number; present: number }
  bytes: { total: number; uploaded: number }
  layers: number
  manifestSize: number
  keySet: 'created' | 'member'
  // `skipped` unless the publish asked for the referrer
  referrer: 'attached' | 'fallback-tag' | 'failed' | 'skipped'
  artifact: BuiltArtifact
}

/** The tag a publish target is written under. */
export function tagOfTarget(target: PublishTarget): string {
  if (target.kind === 'version') {
    return tagOfVersion(target.version)
  }

  const tag = `branch.${target.branch}`
  assertTag(tag)

  return tag
}

async function pool<T, R>(items: T[], width: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length)
  let next = 0

  const lanes = Array.from({ length: Math.min(width, items.length) }, async () => {
    for (;;) {
      const at = next
      next += 1

      if (at >= items.length) {
        return
      }

      out[at] = await work(items[at]!)
    }
  })

  await Promise.all(lanes)

  return out
}

/** Build the artifact a publish would push, without contacting anything. `term host --dry` prints it. */
export async function buildOciArtifact(input: {
  dir: string
  package: string
  version: string
  target: PublishTarget
  link: DeckLinkEntry[]
  local: ObjectStore
  keypair: Keypair
  author: string
  time: string
  message?: string
  params?: ChunkParams
  annotations?: Record<string, string>
  // built output that ships beside the source, such as a console bundle under `host/line`
  include?: string[]
}): Promise<{ release: Release; artifact: BuiltArtifact }> {
  const release = await buildRelease({
    dir: input.dir,
    store: input.local,
    meta: { author: input.author, time: Date.parse(input.time) || 0, message: input.message ?? '' },
    params: input.params,
    include: input.include,
  })

  const read = async (id: string): Promise<Buffer> => {
    const held = release.chunks.get(id)

    return held === undefined ? input.local.get(id) : Buffer.from(held, 'utf8')
  }

  const artifact = await buildArtifact({
    release,
    read,
    package: input.package,
    version: input.version,
    tag: tagOfTarget(input.target),
    link: input.link,
    keypair: input.keypair,
    annotations: input.annotations,
  })

  return { release, artifact }
}

export async function publishToOci(input: {
  dir: string
  package: string
  version: string
  target: PublishTarget
  link: DeckLinkEntry[]
  transport: OciTransport
  repository: OciRepository
  scope: string
  keysRepository: string
  local: ObjectStore
  keypair: Keypair
  author: string
  time: string
  message?: string
  params?: ChunkParams
  annotations?: Record<string, string>
  include?: string[]
  concurrency?: number
  // also attach the signature as an OCI 1.1 referrer (step 7). Off by default; see the header
  referrer?: boolean
  log?: (message: string) => void
}): Promise<OciPublishResult> {
  const log = input.log ?? (() => {})
  const repo = input.repository.name
  const { artifact } = await buildOciArtifact(input)
  const tag = artifact.config.tag

  log(`artifact ${artifact.digest}: ${artifact.blobs.length - 1} layers, ${artifact.packed} objects packed, ${artifact.loose} loose`)

  // 3. the key set: created on the scope's first publish, and otherwise this key must already be a member
  const keys = await ensurePublisher({
    transport: input.transport,
    repository: input.keysRepository,
    scope: input.scope,
    keypair: input.keypair,
  })

  if (keys.created) {
    log(`created the key set of ${input.scope} with this machine's key`)
  }

  // 4. write-once: a version tag that names anything else is a refusal, never an overwrite
  const existing = await input.transport.getManifest({ repository: repo, reference: tag })

  const base = {
    digest: artifact.digest,
    reference: pinnedReference({ repository: input.repository, digest: artifact.digest }),
    tag,
    layers: artifact.blobs.length - 1,
    manifestSize: artifact.manifest.length,
    keySet: keys.created ? ('created' as const) : ('member' as const),
    artifact,
  }

  if (existing && input.target.kind === 'version') {
    if (existing.digest === artifact.digest) {
      return {
        ...base,
        unchanged: true,
        blobs: { total: artifact.blobs.length, uploaded: 0, mounted: 0, present: artifact.blobs.length },
        bytes: { total: artifact.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0), uploaded: 0 },
        referrer: 'skipped',
      }
    }

    throw new OciError(`${input.package}@${input.version} is already published as ${existing.digest}. Versions are write-once: publish a new version`)
  }

  // a branch moves by compare-and-swap where the caller asked for one. OCI has no conditional tag write, so this
  // narrows the race rather than closing it, which is acceptable for a draft and is why no lockfile pins a branch
  if (input.target.kind === 'branch' && input.target.expected !== undefined) {
    const current = existing ? (JSON.parse(existing.bytes.toString('utf8')) as { annotations?: Record<string, string> }).annotations?.[COMMIT_ANNOTATION] : null

    if ((current ?? null) !== input.target.expected) {
      throw new OciError(`branch ${input.target.branch} of ${input.package} moved under you (fast-forward required)`)
    }
  }

  // 5. blobs, the registry's HEAD deciding which are already there
  const outcomes: BlobOutcome[] = await pool(artifact.blobs, input.concurrency ?? 8, blob =>
    input.transport.putBlob({ repository: repo, digest: blob.descriptor.digest, bytes: blob.bytes }),
  )

  const count = (kind: BlobOutcome): number => outcomes.filter(outcome => outcome === kind).length
  const uploadedBytes = artifact.blobs.reduce((sum, blob, at) => sum + (outcomes[at] === 'uploaded' ? blob.bytes.length : 0), 0)

  log(`${count('uploaded')} blobs uploaded, ${count('present')} already present`)

  // 6. the manifest, then the tag read back. A different digest here is a publish that raced this one
  await input.transport.putManifest({ repository: repo, reference: tag, bytes: artifact.manifest, mediaType: MANIFEST_MEDIA_TYPE })
  const landed = await input.transport.getManifest({ repository: repo, reference: tag })

  if (landed?.digest !== artifact.digest) {
    throw new OciError(`tag ${tag} names ${landed?.digest ?? 'nothing'} after the publish of ${artifact.digest}: another publish raced this one`)
  }

  // 7. the signature as a referrer, when asked. Best effort: the signature that matters is already in the config
  const referrer = input.referrer
    ? await attachSignature({
        transport: input.transport,
        repository: repo,
        subject: { mediaType: MANIFEST_MEDIA_TYPE, digest: artifact.digest, size: artifact.manifest.length },
        artifact,
      }).catch((error: unknown) => {
        log(`signature referrer not attached: ${(error as Error).message}`)

        return 'failed' as const
      })
    : ('skipped' as const)

  return {
    ...base,
    unchanged: false,
    blobs: { total: artifact.blobs.length, uploaded: count('uploaded'), mounted: count('mounted'), present: count('present') },
    bytes: { total: artifact.blobs.reduce((sum, blob) => sum + blob.bytes.length, 0), uploaded: uploadedBytes },
    referrer,
  }
}

/**
 * Push the signature referrer. A registry with the referrers API says so with `OCI-Subject` on the PUT. One
 * without it gets the spec's fallback: an image index tagged `sha256-<hex>` listing the referrers of that digest.
 */
export async function attachSignature(input: {
  transport: OciTransport
  repository: string
  subject: Descriptor
  artifact: BuiltArtifact
}): Promise<'attached' | 'fallback-tag'> {
  const referrer = buildSignatureReferrer({ subject: input.subject, config: input.artifact.config })

  await input.transport.putBlob({ repository: input.repository, digest: EMPTY_DESCRIPTOR.digest, bytes: EMPTY_BYTES })
  await input.transport.putBlob({ repository: input.repository, digest: referrer.layer.descriptor.digest, bytes: referrer.layer.bytes })

  const { digest, subjectAccepted } = await input.transport.putManifest({
    repository: input.repository,
    reference: sha256Digest(referrer.manifest),
    bytes: referrer.manifest,
    mediaType: MANIFEST_MEDIA_TYPE,
  })

  if (subjectAccepted) {
    return 'attached'
  }

  const fallback = `sha256-${input.subject.digest.slice('sha256:'.length)}`
  const current = await input.transport.getManifest({ repository: input.repository, reference: fallback })
  const index = current
    ? (JSON.parse(current.bytes.toString('utf8')) as { manifests?: Descriptor[] })
    : { manifests: [] as Descriptor[] }
  const manifests = (index.manifests ?? []).filter(entry => entry.digest !== digest)

  manifests.push({ mediaType: MANIFEST_MEDIA_TYPE, digest, size: referrer.manifest.length, artifactType: SIGNATURE_ARTIFACT_TYPE })

  await input.transport.putManifest({
    repository: input.repository,
    reference: fallback,
    bytes: Buffer.from(JSON.stringify({ schemaVersion: 2, mediaType: INDEX_MEDIA_TYPE, manifests })),
    mediaType: INDEX_MEDIA_TYPE,
  })

  return 'fallback-tag'
}
