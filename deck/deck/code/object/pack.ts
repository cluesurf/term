/**
 * Object packing: bundle many small text blobs into solid-compressed
 * content-addressed packs, so a large package transfers as a few hundred
 * pack objects instead of ~ninety thousand loose ones, and its tiny source
 * files compress against a shared dictionary (see note/term/registry/17).
 *
 * The rule is a hybrid store: binaries and large text stay LOOSE (their own
 * object, streamable, perfect dedup); only small text is PACKED. Packs are
 * cut by CONTENT (a boundary decided by each blob's id over the sorted file
 * list), so changing one file re-cuts one local pack and every other pack
 * keeps its hash and is never re-sent — the same content-defined idea the
 * chunker and the prolly tree use, at the pack scale.
 *
 * A pack's on-disk form is `gzip( u32(tocLen) + tocJson + body )`, where the
 * TOC maps each contained blob id to its `site` (offset into `body`) and
 * `size` (length), and `body` is the reconstructed file bytes concatenated
 * in order. The pack is content-addressed by its compressed bytes.
 */

import { gzipSync, gunzipSync } from 'zlib'
import { Blob, idNumber } from './model'
import { hashObject } from './hash'
import { ObjectStore } from './store'

/** Where a blob's bytes physically live. `loose` is the default (its own object). */
export type Placement =
  | { kind: 'loose' }
  | { kind: 'pack'; pack: string; site: number; size: number }

/** A built pack: its content id, its compressed bytes, and the blob ids it holds. */
export type Pack = {
  id: string
  bytes: Buffer
  blobs: string[]
}

/** One packable input: a blob id, a representative path (for ordering), and its raw file bytes. */
export type PackInput = {
  id: string
  path: string
  bytes: Buffer
}

/**
 * Packing parameters. `looseThreshold` is the size at/above which a text
 * blob stays loose; `minPack`/`maxPack` bound a pack; `boundaryAvg` sets how
 * often a blob id is a content-defined cut point once past `minPack`.
 */
export type PackParams = {
  looseThreshold: number
  minPack: number
  maxPack: number
  boundaryAvg: number
}

export const DEFAULT_PACK_PARAMS: PackParams = {
  looseThreshold: 64 * 1024,
  minPack: 256 * 1024,
  maxPack: 1024 * 1024,
  boundaryAvg: 64,
}

// Extensions whose bytes are not text: always stored loose (already compressed,
// must stay streamable). Kept in sync with the serving transport's set.
const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'avif', 'bmp', 'svg',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'mp3', 'wav', 'ogg', 'mp4', 'webm', 'mov',
  'pdf', 'wasm', 'zip', 'gz', 'br', 'zst', 'tar',
])

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/')
  const name = slash >= 0 ? path.slice(slash + 1) : path
  const dot = name.lastIndexOf('.')

  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

/** Is a blob small text (packable), given its path, size, and bytes? */
export function isPackable(input: {
  path: string
  size: number
  bytes: Buffer
  params?: PackParams
}): boolean {
  const params = input.params ?? DEFAULT_PACK_PARAMS

  if (input.size >= params.looseThreshold) {
    return false
  }

  if (BINARY_EXT.has(extensionOf(input.path))) {
    return false
  }

  // a non-UTF-8 payload is binary regardless of extension
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(input.bytes)
  } catch {
    return false
  }

  return true
}

/** Reconstruct a blob's full file bytes by concatenating its chunks from the store. */
export async function reconstructBlob(input: {
  blobId: string
  store: ObjectStore
}): Promise<Buffer> {
  const blob = JSON.parse(
    (await input.store.get(input.blobId)).toString('utf8'),
  ) as Blob
  const parts: Buffer[] = []

  for (const chunkId of blob.chunks) {
    parts.push(await input.store.get(chunkId))
  }

  return Buffer.concat(parts)
}

// A blob id is a content-defined pack boundary at the given average: true for
// roughly 1 in `avg` ids, decided by the id's own hash, so pack cuts depend
// only on content and are stable across publishes.
function isPackBoundary(id: string, avg: number): boolean {
  const bits = Math.max(1, Math.round(Math.log2(avg)))
  const mask = (1 << bits) - 1

  return (idNumber(id) & mask) === 0
}

// Serialize one pack: gzip( u32(tocLen) + tocJson + body ). The TOC lists each
// blob's offset into `body` and length, so the pack is self-describing.
function sealPack(entries: { id: string; bytes: Buffer }[]): Pack {
  const toc: { id: string; site: number; size: number }[] = []
  const bodyParts: Buffer[] = []
  let site = 0

  for (const entry of entries) {
    toc.push({ id: entry.id, site, size: entry.bytes.length })
    bodyParts.push(entry.bytes)
    site += entry.bytes.length
  }

  const tocJson = Buffer.from(JSON.stringify({ v: 1, toc }), 'utf8')
  const head = Buffer.alloc(4)
  head.writeUInt32BE(tocJson.length, 0)
  const raw = Buffer.concat([head, tocJson, ...bodyParts])
  const bytes = gzipSync(raw, { level: 9 })

  return {
    id: hashObject({ kind: 'pack', bytes }),
    bytes,
    blobs: toc.map(e => e.id),
  }
}

/**
 * Group packable blobs into content-defined packs. Inputs must already be
 * sorted by path (directory-major), so similar and co-changing files sit
 * together. Returns the built packs and the placement of every input blob.
 */
export function buildPacks(input: {
  blobs: PackInput[]
  params?: PackParams
}): { packs: Pack[]; placement: Map<string, Placement> } {
  const params = input.params ?? DEFAULT_PACK_PARAMS
  const packs: Pack[] = []
  const placement = new Map<string, Placement>()

  let current: { id: string; bytes: Buffer }[] = []
  let currentSize = 0

  const flush = (): void => {
    if (current.length === 0) {
      return
    }

    const pack = sealPack(current)
    packs.push(pack)

    let site = 0
    for (const entry of current) {
      placement.set(entry.id, {
        kind: 'pack',
        pack: pack.id,
        site,
        size: entry.bytes.length,
      })
      site += entry.bytes.length
    }

    current = []
    currentSize = 0
  }

  // dedup by blob id (the same content at many paths packs once), preserving
  // the path order the caller established
  const seen = new Set<string>()

  for (const blob of input.blobs) {
    if (seen.has(blob.id)) {
      continue
    }
    seen.add(blob.id)

    current.push({ id: blob.id, bytes: blob.bytes })
    currentSize += blob.bytes.length

    const atBoundary =
      currentSize >= params.minPack &&
      isPackBoundary(blob.id, params.boundaryAvg)

    if (currentSize >= params.maxPack || atBoundary) {
      flush()
    }
  }

  flush()

  return { packs, placement }
}

/** An opened pack: its decompressed body and the TOC, ready for slicing. */
export type OpenPack = {
  body: Buffer
  toc: { id: string; site: number; size: number }[]
}

/** Decompress and parse a pack's bytes into its body + TOC. */
export function openPack(bytes: Buffer): OpenPack {
  const raw = gunzipSync(bytes)
  const tocLen = raw.readUInt32BE(0)
  const toc = (
    JSON.parse(raw.subarray(4, 4 + tocLen).toString('utf8')) as {
      v: number
      toc: { id: string; site: number; size: number }[]
    }
  ).toc
  const body = raw.subarray(4 + tocLen)

  return { body, toc }
}

/** Extract one blob's bytes from an opened pack, by offset and length. */
export function slicePack(
  open: OpenPack,
  site: number,
  size: number,
): Buffer {
  return open.body.subarray(site, site + size)
}
