// A FACE (term-cli-in-term-0115, INTEGRATE @term/deck): deck/deck/code/oci/artifact.ts's exports, with
// their shapes, answered by deck/deck/code/oci/artifact-format.tree.
// The logic is Term; this file only converts shapes for TypeScript callers.
// The original is kept byte for byte at deck/term/deck/term/tmp/retired/make/deck-oci-artifact.
import * as port from '@term/deck/code/oci/artifact-format'
import { ociErrorOf } from './transport'
import type { Descriptor } from './transport'
import type { Keypair } from '../object/sign'
import type { OpenPack } from '../object/pack'
import type { Release } from '../object/release'

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

export const ARTIFACT_TYPE = p.artifactType!() as string
export const CONFIG_MEDIA_TYPE = p.configMediaType!() as string
export const FILES_MEDIA_TYPE = p.filesMediaType!() as string
export const PACK_MEDIA_TYPE = p.packMediaType!() as string
export const OBJECT_MEDIA_TYPE = p.objectMediaType!() as string
export const SIGNATURE_ARTIFACT_TYPE = p.signatureArtifactType!() as string
export const SIGNATURE_MEDIA_TYPE = p.signatureMediaType!() as string
export const EMPTY_MEDIA_TYPE = p.emptyMediaType!() as string
export const COMMIT_ANNOTATION = p.commitAnnotation!() as string
export const EMPTY_BYTES = p.emptyBytes!() as Buffer
export const EMPTY_DESCRIPTOR = p.emptyDescriptor!() as Descriptor
export const LIMITS = p.artifactLimits!() as { config: number; files: number; pack: number; packOpen: number; object: number; layers: number }

export type DeckLinkEntry = { deck: string; code: string }
export type DeckConfig = { v: 1; package: string; version: string; tag: string; commit: string; tree: string; link: DeckLinkEntry[]; key: string; sig: string }
export type FilesLayer = {
  v: 1
  package: string
  version: string
  commit: string
  files: { path: string; mode: string; size: number; chunks: string[] }[]
  packs: { digest: string; objects: [string, number, number][] }[]
}
export type Blob = { descriptor: Descriptor; bytes: Buffer }
export type BuiltArtifact = { manifest: Buffer; digest: string; config: DeckConfig; files: FilesLayer; blobs: Blob[]; packed: number; loose: number }
export type ParsedManifest = { config: Descriptor; files: Descriptor; packs: Descriptor[]; loose: Descriptor[]; commit: string; annotations: Record<string, string> }

export const deckStatement = (input: Omit<DeckConfig, 'v' | 'key' | 'sig'>): string => p.deckStatement!(input) as string

export const buildArtifact = (input: {
  release: Release
  read: (id: string) => Promise<Buffer>
  package: string
  version: string
  tag: string
  link: DeckLinkEntry[]
  keypair: Keypair
  annotations?: Record<string, string>
}): Promise<BuiltArtifact> =>
  liftAsync(() => p.buildArtifact!(input.release, input.read, input.package, input.version, input.tag, input.link, input.keypair, input.annotations) as Promise<BuiltArtifact>)

export const checkClosure = (input: { closure: string[]; files: FilesLayer; layers: Descriptor[] }): void =>
  lift(() => p.checkClosure!(input.closure, input.files, input.layers) as void)

export const parseDeckManifest = (bytes: Buffer): ParsedManifest => lift(() => p.parseDeckManifest!(bytes) as ParsedManifest)

export const parseDeckConfig = (bytes: Buffer): DeckConfig => lift(() => p.parseDeckConfig!(bytes) as DeckConfig)

export const verifyDeckConfig = (input: { config: DeckConfig; manifest: ParsedManifest; package: string; tag?: string; version?: string }): void =>
  lift(() => p.verifyDeckConfig!(input.config, input.manifest, input.package, input.tag, input.version) as void)

export const parseFilesLayer = (input: { bytes: Buffer; manifest: ParsedManifest; config: DeckConfig }): FilesLayer =>
  lift(() => p.parseFilesLayer!(input.bytes, input.manifest, input.config) as FilesLayer)

export const openRemotePack = (input: { bytes: Buffer; expect: [string, number, number][] }): OpenPack =>
  lift(() => p.openRemotePack!(input.bytes, input.expect) as OpenPack)

export const buildSignatureReferrer = (input: { subject: Descriptor; config: DeckConfig }): { manifest: Buffer; layer: Blob } =>
  p.buildSignatureReferrer!(input.subject, input.config) as { manifest: Buffer; layer: Blob }
