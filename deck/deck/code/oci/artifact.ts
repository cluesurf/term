// The OCI artifact a Term version is, built from a release and read back, with every rule it has to obey checked
// in both directions (note/term/registry/18-oci-registry-default.md, "The artifact format").
//
//   manifest   an OCI 1.1 image manifest, `artifactType` application/vnd.cluesurf.term.deck.v1
//   config     who published what: package, version, tag, commit, tree, links, the key and the signature
//   layer 0    the files layer: every file's path, mode, size and chunks, and where each packed object sits
//   layer 1..  packs, from `buildPacks`, byte for byte
//   layer n..  loose objects: anything binary or of 64 KB or more, under its own id
//
// THE CLOSURE RULE. Every object the commit reaches is in a listed layer, either packed or loose. A registry
// garbage-collects a blob no manifest references, and `oras pull` must fetch a complete version, so a manifest that
// leans on another version's layers is refused here when it is built and again when it is read.
//
// THE SIGNED STATEMENT. The signature covers the package, the version, the tag, the commit, the tree's top node and the
// links, not the commit alone. A signature over the commit alone could be lifted onto another package's tag, onto
// an older version's tag, or beside a config whose links were edited to pull in something else. Every field a
// resolver acts on is in the statement, so none of them can be changed without the key.

import { gunzipSync } from 'zlib'

import type { Release } from '../object/release'
import { buildPacks, DEFAULT_PACK_PARAMS, type OpenPack } from '../object/pack'
import { signId, verifyId, type Keypair } from '../object/sign'
import { isDigest } from './reference'
import { MANIFEST_MEDIA_TYPE, OciError, sha256Digest, isDescriptor, type Descriptor } from './transport'

export const ARTIFACT_TYPE = 'application/vnd.cluesurf.term.deck.v1'
export const CONFIG_MEDIA_TYPE = 'application/vnd.cluesurf.term.deck.config.v1+json'
export const FILES_MEDIA_TYPE = 'application/vnd.cluesurf.term.files.v1+json'
export const PACK_MEDIA_TYPE = 'application/vnd.cluesurf.term.pack.v1+gzip'
export const OBJECT_MEDIA_TYPE = 'application/vnd.cluesurf.term.object.v1'
export const SIGNATURE_ARTIFACT_TYPE = 'application/vnd.cluesurf.term.signature.v1'
export const SIGNATURE_MEDIA_TYPE = 'application/vnd.cluesurf.term.signature.v1+json'
export const EMPTY_MEDIA_TYPE = 'application/vnd.oci.empty.v1+json'

export const COMMIT_ANNOTATION = 'surf.clue.term.commit'
// every layer carries a flat title, so `oras pull` writes the whole version into one directory under names that
// say what each blob is
const TITLE = 'org.opencontainers.image.title'

// The OCI empty descriptor: the two bytes `{}`.
export const EMPTY_BYTES = Buffer.from('{}')
export const EMPTY_DESCRIPTOR: Descriptor = {
  mediaType: EMPTY_MEDIA_TYPE,
  digest: sha256Digest(EMPTY_BYTES),
  size: EMPTY_BYTES.length,
}

// What a reader will accept, so a hostile registry cannot make an install allocate without bound.
export const LIMITS = {
  config: 1024 * 1024,
  files: 256 * 1024 * 1024,
  pack: 64 * 1024 * 1024,
  // what a pack may decompress to: `maxPack` is 1 MB of input, so this is generous and still bounded
  packOpen: 256 * 1024 * 1024,
  object: 2 * 1024 * 1024 * 1024,
  layers: 100_000,
}

const KEY = /^[A-Za-z0-9+/]{40,200}={0,2}$/
const SIG = /^ed25519:[A-Za-z0-9+/]{80,100}={0,2}$/

export type DeckLinkEntry = { deck: string; code: string }

export type DeckConfig = {
  v: 1
  package: string
  version: string
  // the tag this version was published under: the version, or `branch.<name>`
  tag: string
  commit: string
  // the id of the prolly tree's top node, the file set the commit names
  tree: string
  link: DeckLinkEntry[]
  key: string
  sig: string
}

export type FilesLayer = {
  v: 1
  package: string
  version: string
  commit: string
  files: { path: string; mode: string; size: number; chunks: string[] }[]
  // one entry per pack layer, in layer order: each object it holds, as [id, site, size]
  packs: { digest: string; objects: [string, number, number][] }[]
}

export type Blob = { descriptor: Descriptor; bytes: Buffer }

export type BuiltArtifact = {
  manifest: Buffer
  digest: string
  config: DeckConfig
  files: FilesLayer
  // every blob the manifest names: config, files layer, packs, loose objects
  blobs: Blob[]
  packed: number
  loose: number
}

/** The exact string a deck signature covers. Canonical: fixed key order, links sorted. */
export function deckStatement(input: Omit<DeckConfig, 'v' | 'key' | 'sig'>): string {
  return JSON.stringify({
    type: ARTIFACT_TYPE,
    package: input.package,
    version: input.version,
    tag: input.tag,
    commit: input.commit,
    tree: input.tree,
    link: sortLinks(input.link).map(link => [link.deck, link.code]),
  })
}

function sortLinks(links: DeckLinkEntry[]): DeckLinkEntry[] {
  return [...links].sort((a, b) => (a.deck < b.deck ? -1 : a.deck > b.deck ? 1 : 0))
}

function isText(bytes: Buffer): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)

    return true
  } catch {
    return false
  }
}

/**
 * Build the artifact for a release. `read` returns any object of the closure. The result is deterministic: the same
 * release, links and key give the same manifest digest, which is what lets an unchanged republish be recognized.
 */
export async function buildArtifact(input: {
  release: Release
  read: (id: string) => Promise<Buffer>
  package: string
  version: string
  tag: string
  link: DeckLinkEntry[]
  keypair: Keypair
  annotations?: Record<string, string>
}): Promise<BuiltArtifact> {
  const packable: { id: string; path: string; bytes: Buffer }[] = []
  const loose: Blob[] = []

  for (const id of input.release.closure) {
    const bytes = await input.read(id)

    if (sha256Digest(bytes) !== id) {
      throw new OciError(`object ${id} does not hash to its id, refusing to publish it`)
    }

    if (bytes.length >= DEFAULT_PACK_PARAMS.looseThreshold || !isText(bytes)) {
      loose.push({ descriptor: { mediaType: OBJECT_MEDIA_TYPE, digest: id, size: bytes.length, annotations: { [TITLE]: `object-${id.slice(7)}` } }, bytes })
    } else {
      packable.push({ id, path: id, bytes })
    }
  }

  // IN FILE ORDER: every file's chunks in path order, then the objects no file names (the version's index nodes and
  // commit) by id. The cuts are content-defined (pack.ts), so an unchanged run of files packs to the same digests, and
  // a change re-cuts only the packs around it: the edited file's, and the one holding the index nodes, which change
  // with any edit. Sorted by id alone, as until 2026-10-05, every new object landed at a random place among the
  // others and an edit of one line re-packed 5 of 6 packs (pnpm term:install-bench)
  const rank = new Map<string, number>()

  for (const file of input.release.files) {
    for (const chunk of file.chunks) {
      if (!rank.has(chunk)) {
        rank.set(chunk, rank.size)
      }
    }
  }

  packable.sort((a, b) => {
    const x = rank.get(a.id) ?? Infinity
    const y = rank.get(b.id) ?? Infinity

    return x !== y ? x - y : a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
  loose.sort((a, b) => (a.descriptor.digest < b.descriptor.digest ? -1 : 1))

  const { packs, placement } = buildPacks({ blobs: packable })
  const packLayers: Blob[] = packs.map(pack => ({
    descriptor: { mediaType: PACK_MEDIA_TYPE, digest: pack.id, size: pack.bytes.length, annotations: { [TITLE]: `pack-${pack.id.slice(7)}.gz` } },
    bytes: pack.bytes,
  }))

  const files: FilesLayer = {
    v: 1,
    package: input.package,
    version: input.version,
    commit: input.release.commit,
    files: input.release.files.map(file => ({ path: file.path, mode: file.mode, size: file.size, chunks: file.chunks })),
    packs: packs.map(pack => ({
      digest: pack.id,
      objects: pack.blobs.map(id => {
        const at = placement.get(id)

        if (at?.kind !== 'pack') {
          throw new OciError(`packed object ${id} has no placement`)
        }

        return [id, at.site, at.size] as [string, number, number]
      }),
    })),
  }

  const filesBytes = Buffer.from(JSON.stringify(files))
  const filesLayer: Blob = {
    descriptor: { mediaType: FILES_MEDIA_TYPE, digest: sha256Digest(filesBytes), size: filesBytes.length, annotations: { [TITLE]: 'files.json' } },
    bytes: filesBytes,
  }

  const link = sortLinks(input.link)
  const body = { package: input.package, version: input.version, tag: input.tag, commit: input.release.commit, tree: input.release.root, link }
  const config: DeckConfig = {
    v: 1,
    ...body,
    key: input.keypair.publicKey,
    sig: signId({ id: deckStatement(body), privateKey: input.keypair.privateKey }),
  }

  const configBytes = Buffer.from(JSON.stringify(config))
  const configBlob: Blob = {
    descriptor: { mediaType: CONFIG_MEDIA_TYPE, digest: sha256Digest(configBytes), size: configBytes.length },
    bytes: configBytes,
  }

  const layers = [filesLayer, ...packLayers, ...loose]

  checkClosure({ closure: input.release.closure, files, layers: layers.map(layer => layer.descriptor) })

  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    artifactType: ARTIFACT_TYPE,
    config: configBlob.descriptor,
    layers: layers.map(layer => layer.descriptor),
    annotations: {
      ...input.annotations,
      'org.opencontainers.image.title': input.package,
      'org.opencontainers.image.version': input.version,
      [COMMIT_ANNOTATION]: input.release.commit,
    },
  }

  const manifestBytes = Buffer.from(JSON.stringify(manifest))

  return {
    manifest: manifestBytes,
    digest: sha256Digest(manifestBytes),
    config,
    files,
    blobs: [configBlob, ...layers],
    packed: packable.length,
    loose: loose.length,
  }
}

/** The closure rule: every object the commit reaches sits in a pack the files layer places it in, or is a loose layer. */
export function checkClosure(input: { closure: string[]; files: FilesLayer; layers: Descriptor[] }): void {
  const held = new Set<string>()

  for (const layer of input.layers) {
    if (layer.mediaType === OBJECT_MEDIA_TYPE) {
      held.add(layer.digest)
    }
  }

  const packLayers = new Set(input.layers.filter(layer => layer.mediaType === PACK_MEDIA_TYPE).map(layer => layer.digest))

  for (const pack of input.files.packs) {
    if (!packLayers.has(pack.digest)) {
      throw new OciError(`the files layer places objects in pack ${pack.digest}, which the manifest does not list`)
    }

    for (const [id] of pack.objects) {
      held.add(id)
    }
  }

  const absent = input.closure.filter(id => !held.has(id))

  if (absent.length > 0) {
    throw new OciError(`closure incomplete: ${absent.length} objects are in no listed layer, the first ${absent[0]}`)
  }
}

export type ParsedManifest = {
  config: Descriptor
  files: Descriptor
  packs: Descriptor[]
  loose: Descriptor[]
  commit: string
  annotations: Record<string, string>
}

/** Read a manifest's bytes back, refusing anything that is not a Term deck artifact of exactly this shape. */
export function parseDeckManifest(bytes: Buffer): ParsedManifest {
  let manifest: {
    schemaVersion?: number
    mediaType?: string
    artifactType?: string
    config?: unknown
    layers?: unknown[]
    annotations?: Record<string, string>
  }

  try {
    manifest = JSON.parse(bytes.toString('utf8'))
  } catch {
    throw new OciError('manifest is not JSON')
  }

  if (manifest.schemaVersion !== 2 || manifest.mediaType !== MANIFEST_MEDIA_TYPE) {
    throw new OciError(`manifest is not an OCI image manifest (${manifest.mediaType ?? 'no media type'})`)
  }

  if (manifest.artifactType !== ARTIFACT_TYPE) {
    throw new OciError(`manifest is a ${manifest.artifactType ?? 'plain image'}, not a Term deck (${ARTIFACT_TYPE})`)
  }

  if (!isDescriptor(manifest.config) || manifest.config.mediaType !== CONFIG_MEDIA_TYPE) {
    throw new OciError('manifest config is not a Term deck config')
  }

  const layers = manifest.layers ?? []

  if (!Array.isArray(layers) || layers.length === 0 || layers.length > LIMITS.layers || !layers.every(isDescriptor)) {
    throw new OciError('manifest layers are malformed')
  }

  const [files, ...rest] = layers as Descriptor[]

  if (files!.mediaType !== FILES_MEDIA_TYPE) {
    throw new OciError('the first layer is not the files layer')
  }

  const packs = rest.filter(layer => layer.mediaType === PACK_MEDIA_TYPE)
  const loose = rest.filter(layer => layer.mediaType === OBJECT_MEDIA_TYPE)

  if (packs.length + loose.length !== rest.length) {
    throw new OciError('manifest holds a layer of an unknown media type')
  }

  const annotations = manifest.annotations ?? {}
  const commit = annotations[COMMIT_ANNOTATION]

  if (!commit || !isDigest(commit)) {
    throw new OciError(`manifest has no ${COMMIT_ANNOTATION} annotation`)
  }

  return { config: manifest.config, files: files!, packs, loose, commit, annotations }
}

/** Read a config blob back, refusing anything malformed. Does not verify the signature: `verifyDeckConfig` does. */
export function parseDeckConfig(bytes: Buffer): DeckConfig {
  let config: DeckConfig

  try {
    config = JSON.parse(bytes.toString('utf8')) as DeckConfig
  } catch {
    throw new OciError('deck config is not JSON')
  }

  const text = (value: unknown): boolean => typeof value === 'string' && value.length > 0 && value.length < 512

  if (
    config.v !== 1 ||
    !text(config.package) ||
    !text(config.version) ||
    !text(config.tag) ||
    !isDigest(config.commit) ||
    !isDigest(config.tree) ||
    !Array.isArray(config.link) ||
    config.link.length > 10_000 ||
    !config.link.every(link => text(link?.deck) && text(link?.code)) ||
    typeof config.key !== 'string' ||
    !KEY.test(config.key) ||
    typeof config.sig !== 'string' ||
    !SIG.test(config.sig)
  ) {
    throw new OciError('deck config is malformed')
  }

  return config
}

/**
 * Verify a config: it names the package and tag it was fetched as, it agrees with its manifest about the commit,
 * and its signature verifies under its own key. Whether that KEY may publish the package is the trust policy's
 * question (`keys.ts`), not this one.
 */
export function verifyDeckConfig(input: {
  config: DeckConfig
  manifest: ParsedManifest
  package: string
  // the tag it was fetched by, when it was fetched by tag
  tag?: string
  // the version the caller expects, when it knows one
  version?: string
}): void {
  const { config } = input

  if (config.package !== input.package) {
    throw new OciError(`the artifact is ${config.package}, not ${input.package}`)
  }

  if (input.tag !== undefined && config.tag !== input.tag) {
    throw new OciError(`tag ${input.tag} serves an artifact signed for tag ${config.tag}`)
  }

  if (input.version !== undefined && config.version !== input.version) {
    throw new OciError(`expected ${input.package}@${input.version}, the artifact is ${config.version}`)
  }

  if (config.commit !== input.manifest.commit) {
    throw new OciError(`config commit ${config.commit} disagrees with the manifest's ${input.manifest.commit}`)
  }

  if (!verifyId({ id: deckStatement(config), sig: config.sig, publicKey: config.key })) {
    throw new OciError(`the signature on ${config.package}@${config.version} does not verify`)
  }
}

/** Read the files layer back and hold it to its manifest. */
export function parseFilesLayer(input: { bytes: Buffer; manifest: ParsedManifest; config: DeckConfig }): FilesLayer {
  let files: FilesLayer

  try {
    files = JSON.parse(input.bytes.toString('utf8')) as FilesLayer
  } catch {
    throw new OciError('files layer is not JSON')
  }

  if (files.v !== 1 || files.commit !== input.config.commit || !Array.isArray(files.packs) || !Array.isArray(files.files)) {
    throw new OciError('files layer is malformed or names another commit')
  }

  if (files.packs.length !== input.manifest.packs.length) {
    throw new OciError(`files layer places objects in ${files.packs.length} packs, the manifest lists ${input.manifest.packs.length}`)
  }

  files.packs.forEach((pack, at) => {
    if (pack.digest !== input.manifest.packs[at]!.digest || !Array.isArray(pack.objects)) {
      throw new OciError(`files layer pack ${at} is not the manifest's pack ${at}`)
    }

    for (const entry of pack.objects) {
      if (!Array.isArray(entry) || !isDigest(entry[0]) || !Number.isSafeInteger(entry[1]) || !Number.isSafeInteger(entry[2])) {
        throw new OciError(`files layer pack ${at} holds a malformed placement`)
      }
    }
  })

  return files
}

/**
 * Open a pack fetched from a registry: bounded decompression, a TOC that must fit inside the body, and the exact
 * set of objects the files layer said the pack holds. `openPack` in object/pack.ts trusts its input, which is right
 * for a pack this process just built and wrong for one a registry sent.
 */
export function openRemotePack(input: { bytes: Buffer; expect: [string, number, number][] }): OpenPack {
  let raw: Buffer

  try {
    raw = gunzipSync(input.bytes, { maxOutputLength: LIMITS.packOpen })
  } catch (error) {
    throw new OciError(`pack does not decompress within ${LIMITS.packOpen} bytes: ${(error as Error).message}`)
  }

  if (raw.length < 4) {
    throw new OciError('pack is truncated')
  }

  const tocLen = raw.readUInt32BE(0)

  if (4 + tocLen > raw.length) {
    throw new OciError('pack table of contents runs past the pack')
  }

  let toc: { id: string; site: number; size: number }[]

  try {
    toc = (JSON.parse(raw.subarray(4, 4 + tocLen).toString('utf8')) as { toc: typeof toc }).toc
  } catch {
    throw new OciError('pack table of contents is not JSON')
  }

  const body = raw.subarray(4 + tocLen)

  if (!Array.isArray(toc) || toc.length !== input.expect.length) {
    throw new OciError(`pack holds ${Array.isArray(toc) ? toc.length : 0} objects, the files layer says ${input.expect.length}`)
  }

  toc.forEach((entry, at) => {
    const [id, site, size] = input.expect[at]!

    if (entry.id !== id || entry.site !== site || entry.size !== size || site < 0 || size < 0 || site + size > body.length) {
      throw new OciError(`pack entry ${at} is not where the files layer placed ${id}`)
    }
  })

  return { body, toc }
}

/** The signature referrer: an artifact whose subject is a version's manifest, readable by `oras discover`. */
export function buildSignatureReferrer(input: { subject: Descriptor; config: DeckConfig }): { manifest: Buffer; layer: Blob } {
  const bytes = Buffer.from(
    JSON.stringify({ statement: deckStatement(input.config), sig: input.config.sig, key: input.config.key }),
  )
  const layer: Blob = { descriptor: { mediaType: SIGNATURE_MEDIA_TYPE, digest: sha256Digest(bytes), size: bytes.length }, bytes }
  const manifest = {
    schemaVersion: 2,
    mediaType: MANIFEST_MEDIA_TYPE,
    artifactType: SIGNATURE_ARTIFACT_TYPE,
    config: EMPTY_DESCRIPTOR,
    layers: [layer.descriptor],
    subject: input.subject,
  }

  return { manifest: Buffer.from(JSON.stringify(manifest)), layer }
}
