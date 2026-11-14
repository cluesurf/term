// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/artifact.ts's exports, with
// their shapes, answered by deck/deck/code/oci/artifact-format.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-artifact.
// Artifact format v2 (decision 129 section 2 of the self-host change, decisions 154 and 158, item
// term-self-host-001-1043): one gzip ustar archive layer, a config that signs it, no files layer, packs or referrer.
import * as port from '@term/deck/code/oci/artifact-format'
import { ociErrorOf } from './transport'
import type { Descriptor } from './transport'
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

export const ARTIFACT_TYPE = p.artifactType!() as string
export const CONFIG_MEDIA_TYPE = p.configMediaType!() as string
export const ARCHIVE_MEDIA_TYPE = p.archiveMediaType!() as string
export const ARCHIVE_TITLE = p.archiveTitle!() as string
export const EMPTY_MEDIA_TYPE = p.emptyMediaType!() as string
export const EMPTY_BYTES = p.emptyBytes!() as Buffer
export const EMPTY_DESCRIPTOR = p.emptyDescriptor!() as Descriptor
export const LIMITS = p.artifactLimits!() as {
  config: number
  archive: number
  unpacked: number
  layers: number
}

export type DeckLinkEntry = { deck: string; code: string }
// the archive layer as the statement and the config name it
export type ArchiveDescriptor = {
  digest: string
  size: number
  mediaType: string
}
export type DeckConfig = {
  type: string
  package: string
  version: string
  tag: string
  link: DeckLinkEntry[]
  archive: ArchiveDescriptor
  key: string
  sig: string
}
// one entry of a version's files, as oci/version-files.tree walks them and oci/archive.tree writes them
export type ArchiveEntry = {
  path: string
  kind: 'file' | 'directory'
  executable: boolean
  bytes: Buffer
}
// OWED, not a shape: deck/deck/code/index.ts (decision 153, its last importers waiting on 1044 and 1278) still
// re-exports this v1 name. The v1 files layer is gone, so nothing has this type
export type FilesLayer = never
export type Blob = { descriptor: Descriptor; bytes: Buffer }
export type BuiltArtifact = {
  manifest: Buffer
  digest: string
  config: DeckConfig
  archive: ArchiveDescriptor
  blobs: Blob[]
  entries: number
}
export type ParsedManifest = {
  config: Descriptor
  archive: Descriptor
  digest: string
  annotations: Record<string, string>
}

export const deckStatement = (
  input: Omit<DeckConfig, 'type' | 'key' | 'sig'>,
): string => p.deckStatement!(input) as string

export const buildArtifact = (input: {
  entries: ArchiveEntry[]
  package: string
  version: string
  tag: string
  link: DeckLinkEntry[]
  keypair: Keypair
  annotations?: Record<string, string>
}): BuiltArtifact =>
  lift(
    () =>
      p.buildArtifact!(
        input.entries,
        input.package,
        input.version,
        input.tag,
        input.link,
        input.keypair,
        input.annotations,
      ) as BuiltArtifact,
  )

export const parseDeckManifest = (bytes: Buffer): ParsedManifest =>
  lift(() => p.parseDeckManifest!(bytes) as ParsedManifest)

export const parseDeckConfig = (bytes: Buffer): DeckConfig =>
  lift(() => p.parseDeckConfig!(bytes) as DeckConfig)

// decision 158 rule 2 steps 1 to 3: the manifest against the pin, the config bytes against the manifest, the
// signature and the request, the manifest's layer against the signed archive
export const verifyDeckConfig = (input: {
  config: DeckConfig
  manifest: ParsedManifest
  package: string
  tag?: string
  version?: string
  configBytes: Buffer
  pin?: string
}): void =>
  lift(
    () =>
      p.verifyDeckConfig!(
        input.config,
        input.manifest,
        input.package,
        input.tag,
        input.version,
        input.configBytes,
        input.pin,
      ) as void,
  )

// decision 158 rule 2 step 4: the fetched archive layer held to the signed archive before a byte of it is inflated
export const checkArchiveLayer = (input: {
  bytes: Buffer
  config: DeckConfig
}): void =>
  lift(() => p.checkArchiveLayer!(input.bytes, input.config) as void)
