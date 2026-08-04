/**
 * The registry manifest: a published deck's flat file listing with
 * placement, emitted and parsed as `.tree` (note/term/registry/14 + 17).
 *
 * Head `deck @scope/name`; `code` pins the ref with its commit `hash`
 * nested. Each file is a `link <path>` naming its content `hash` and `size`;
 * placement is a `base` child (the pack it is grouped in, with `site` the
 * byte offset) or, by default, none — a loose object. A large package's
 * manifest is sharded: the root lists `base <shard-hash>` entries (a
 * content-defined sitemap index), each a sub-manifest covering a path range.
 *
 * This is the running implementation; the self-hosted mill grammar in
 * @term/mill/code/base is the formal spec of the same format.
 */

import { ManifestFile } from './graph'
import { Placement } from './pack'
import { hashObjectText } from './hash'
import { idNumber } from './model'

// content type by extension, emitted as `mime` on loose entries so a UI /
// the CDN serves them correctly. Only what the registry actually serves.
const MIME: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif',
  webp: 'image/webp', ico: 'image/x-icon', avif: 'image/avif', svg: 'image/svg+xml',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf',
  mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg',
  mp4: 'video/mp4', webm: 'video/webm', mov: 'video/quicktime',
  pdf: 'application/pdf', wasm: 'application/wasm', json: 'application/json',
  css: 'text/css', js: 'text/javascript', html: 'text/html',
}

function mimeOf(path: string): string | undefined {
  const dot = path.lastIndexOf('.')
  return dot > 0 ? MIME[path.slice(dot + 1).toLowerCase()] : undefined
}

/** One file entry in a manifest. `pack` absent = a loose object (the default). */
export type ManifestEntry = {
  path: string
  hash: string
  size: number
  mime?: string
  pack?: string
  site?: number
}

/** A leaf manifest: the full file listing for a small/medium package. */
export type HoldManifest = {
  package: string
  ref: string
  hash: string
  files: ManifestEntry[]
}

/** One shard in a large manifest's index. */
export type ManifestShard = {
  hash: string
  foot: string
  head: string
  size: number
  text: string
}

/** A sharded manifest: the index plus its shard sub-manifests. */
export type ShardedManifest = {
  package: string
  ref: string
  hash: string
  shards: ManifestShard[]
}

/** Build manifest entries from a commit's flat file list and the blob placement. */
export function manifestEntries(input: {
  files: ManifestFile[]
  placement: Map<string, Placement>
}): ManifestEntry[] {
  return input.files.map(file => {
    const where = input.placement.get(file.blob)
    const entry: ManifestEntry = {
      path: file.path,
      hash: file.blob,
      size: file.size,
    }

    if (where && where.kind === 'pack') {
      entry.pack = where.pack
      entry.site = where.site
    } else {
      // loose: carry a mime so the CDN serves it with the right content-type
      const mime = mimeOf(file.path)
      if (mime) {
        entry.mime = mime
      }
    }

    return entry
  })
}

/** Emit one `link` entry block. */
function emitEntry(entry: ManifestEntry): string {
  const lines = [`link ${entry.path}`, `  hash <${entry.hash}>`, `  size ${entry.size}`]

  if (entry.mime) {
    lines.push(`  mime <${entry.mime}>`)
  }

  if (entry.pack !== undefined) {
    lines.push(`  base <${entry.pack}>`)
    lines.push(`    site ${entry.site}`)
  }

  return lines.join('\n')
}

/** Emit a leaf manifest as `.tree` text. */
export function emitManifest(m: HoldManifest): string {
  const head = [`deck ${m.package}`, '', `code <${m.ref}>`, `  hash <${m.hash}>`, '']
  const body = m.files.map(emitEntry)

  return `${head.join('\n')}\n${body.join('\n\n')}\n`
}

/** Emit a shard-index manifest as `.tree` text (a `base <shard-hash>` per shard). */
export function emitShardIndex(m: ShardedManifest): string {
  const head = [`deck ${m.package}`, '', `code <${m.ref}>`, `  hash <${m.hash}>`, '']
  const body = m.shards.map(shard =>
    [`base <${shard.hash}>`, `  foot <${shard.foot}>`, `  head <${shard.head}>`, `  size ${shard.size}`].join('\n'),
  )

  return `${head.join('\n')}\n${body.join('\n\n')}\n`
}

// a path is a content-defined shard boundary at the given average count
function isShardBoundary(path: string, avg: number): boolean {
  const bits = Math.max(1, Math.round(Math.log2(avg)))
  const mask = (1 << bits) - 1
  const id = hashObjectText({ kind: 'tree', text: path })

  return (idNumber(id) & mask) === 0
}

/**
 * Shard a full entry list into content-defined shards. Entries must be sorted
 * by path. A change to one file re-cuts one shard; the rest keep their hash.
 * Below `minShardFiles` the manifest is a single leaf (returns one shard whose
 * text IS the whole leaf manifest).
 */
export function shardManifest(input: {
  package: string
  ref: string
  hash: string
  entries: ManifestEntry[]
  minShardFiles?: number
  avgShardFiles?: number
}): ShardedManifest | HoldManifest {
  const min = input.minShardFiles ?? 4096
  const avg = input.avgShardFiles ?? 2048

  if (input.entries.length <= min) {
    return {
      package: input.package,
      ref: input.ref,
      hash: input.hash,
      files: input.entries,
    }
  }

  const shards: ManifestShard[] = []
  let run: ManifestEntry[] = []

  const flush = (): void => {
    if (run.length === 0) {
      return
    }

    const text = emitManifest({
      package: input.package,
      ref: input.ref,
      hash: input.hash,
      files: run,
    })
    shards.push({
      hash: hashObjectText({ kind: 'tree', text }),
      foot: run[0]!.path,
      head: run[run.length - 1]!.path,
      size: run.length,
      text,
    })
    run = []
  }

  for (const entry of input.entries) {
    run.push(entry)

    if (run.length >= avg / 4 && isShardBoundary(entry.path, avg)) {
      flush()
    }
  }

  flush()

  return {
    package: input.package,
    ref: input.ref,
    hash: input.hash,
    shards,
  }
}

// ---- parsing ----

function tagValue(line: string, tag: string): string | undefined {
  const t = line.trim()
  if (t === tag || !t.startsWith(`${tag} `)) {
    return t === tag ? '' : undefined
  }
  const rest = t.slice(tag.length + 1).trim()
  // strip one <...> wrapper if present
  return rest.startsWith('<') && rest.endsWith('>') ? rest.slice(1, -1) : rest
}

/**
 * Parse a manifest `.tree`. Returns a leaf manifest (files) or a shard index
 * (shards, no `text`), distinguished by whether entries are `link` or `base`.
 */
export function parseManifest(
  text: string,
): HoldManifest | { package: string; ref: string; hash: string; shards: Omit<ManifestShard, 'text'>[] } {
  const lines = text.split('\n')
  let pkg = ''
  let ref = ''
  let hash = ''
  const files: ManifestEntry[] = []
  const shards: Omit<ManifestShard, 'text'>[] = []
  let entry: ManifestEntry | null = null
  let shard: Omit<ManifestShard, 'text'> | null = null

  const closeEntry = (): void => {
    if (entry) {
      files.push(entry)
      entry = null
    }
    if (shard) {
      shards.push(shard)
      shard = null
    }
  }

  for (const line of lines) {
    if (line.trim() === '') {
      continue
    }

    const indent = line.length - line.trimStart().length
    const deck = tagValue(line, 'deck')
    if (deck !== undefined && indent === 0) {
      pkg = deck
      continue
    }

    const link = tagValue(line, 'link')
    if (link !== undefined && indent === 0) {
      closeEntry()
      entry = { path: link, hash: '', size: 0 }
      continue
    }

    // a top-level `code` is the ref; a top-level `base` starts a shard
    if (indent === 0) {
      const code = tagValue(line, 'code')
      if (code !== undefined) {
        closeEntry()
        ref = code
        continue
      }
      const base = tagValue(line, 'base')
      if (base !== undefined) {
        closeEntry()
        shard = { hash: base, foot: '', head: '', size: 0 }
        continue
      }
    }

    // nested fields
    const h = tagValue(line, 'hash')
    if (h !== undefined) {
      if (entry) entry.hash = h
      else hash = h
      continue
    }
    const size = tagValue(line, 'size')
    if (size !== undefined) {
      if (entry) entry.size = Number(size)
      else if (shard) shard.size = Number(size)
      continue
    }
    if (entry) {
      const mime = tagValue(line, 'mime')
      if (mime !== undefined) { entry.mime = mime; continue }
      const base = tagValue(line, 'base')
      if (base !== undefined) { entry.pack = base; continue }
      const site = tagValue(line, 'site')
      if (site !== undefined) { entry.site = Number(site); continue }
    }
    if (shard) {
      const foot = tagValue(line, 'foot')
      if (foot !== undefined) { shard.foot = foot; continue }
      const head = tagValue(line, 'head')
      if (head !== undefined) { shard.head = head; continue }
    }
  }

  closeEntry()

  if (shards.length > 0) {
    return { package: pkg, ref, hash, shards }
  }

  return { package: pkg, ref, hash, files }
}
