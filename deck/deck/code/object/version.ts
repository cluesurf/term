// Building a package version on `@cluesurf/save`.
//
// This replaces the hand-written directory walk in `build.ts` and the nested prolly
// tree in `tree.ts`. A version is a base `Dataset` of file records (see `dataset.ts`),
// written by base's `writeDataset`, so the package manager inherits the tree, the
// O(change) diff, and sync instead of maintaining its own.
//
// The sync / async seam lives here, and it is deliberate. Base's store API is
// SYNCHRONOUS and in-process; the package manager's is ASYNC and networked. So the
// tree is computed in memory against a `MemoryChunkStore`, which is fast and needs no
// awaits, and only then are the resulting chunks shipped to the async object store.
// That is the shape a publish has anyway: compute locally, upload what is missing.

import fsp from 'fs/promises'
import path from 'path'
import { writeDataset } from '@cluesurf/save/store/tree'
import { MemoryChunkStore } from '@cluesurf/save/store/chunk-store'

import { chunkBuffer } from './chunk'
import { classify } from './classify'
import { parseTree } from '@cluesurf/save/tree/parse'
import { formatTree } from '@cluesurf/save/tree/format'
import { canonicalBytes } from '@cluesurf/save/canon/canonicalize'
import type { ChunkParams } from './chunk'
import { hashObject } from './hash'
import type { ObjectStore } from './store'
import { datasetOfFiles } from './dataset'
import type { PackageFile } from './dataset'
import type { EntryMode } from './model'

// files and directories a published package never carries
const DEFAULT_EXCLUDE = new Set([
  'node_modules',
  '.git',
  'host',
  'tmp',
  '.base',
])

// Excluded at the package's top level only: `link/` there is where `term load` links installed dependencies, and a package
// never carries another package's install. A `code/link/` deeper down is source and ships.
const TOP_EXCLUDE = new Set(['link'])

export type BuiltVersion = {
  // the prolly-tree root naming this version's file set
  root: string
  files: Array<PackageFile>
  // the in-memory chunks the tree is made of, to be shipped to the object store
  treeChunks: MemoryChunkStore
}

// Walk a directory into the flat file list a version is made of, chunking each file's
// bytes and putting those chunks in the object store as it goes.
export async function readVersionFiles(input: {
  dir: string
  store: ObjectStore
  params?: ChunkParams
  exclude?: Set<string>
  // root-relative paths shipped even where an exclusion would drop them: a built console under `host/line`, which
  // a package that runs with `node` alone must carry. Only these paths, and the directories leading to them
  include?: Array<string>
}): Promise<Array<PackageFile>> {
  const exclude = input.exclude ?? DEFAULT_EXCLUDE
  const include = (input.include ?? []).map(at => at.replace(/^\.\//, '').replace(/\/+$/, ''))
  const files: Array<PackageFile> = []

  const included = (at: string): boolean =>
    include.some(keep => at === keep || at.startsWith(`${keep}/`))
  const leadsTo = (at: string): boolean =>
    include.some(keep => keep.startsWith(`${at}/`))

  // `partial` is a directory walked only because an included path is inside it: nothing else in it ships
  const walk = async (dir: string, prefix: string, partial = false): Promise<void> => {
    const entries = await fsp.readdir(dir, { withFileTypes: true })

    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name

      if (partial && !included(relative) && !leadsTo(relative)) {
        continue
      }

      if (exclude.has(entry.name) || (prefix === '' && TOP_EXCLUDE.has(entry.name))) {
        if (included(relative)) {
          // shipped whole, below
        } else if (entry.isDirectory() && leadsTo(relative)) {
          await walk(path.join(dir, entry.name), relative, true)
          continue
        } else {
          continue
        }
      }

      // dotfiles are skipped by default, matching the tarball publisher
      if (entry.name.startsWith('.') && entry.name !== '.treeignore') {
        continue
      }

      const full = path.join(dir, entry.name)
      // a path is always POSIX-shaped in the record, whatever the host
      const at = prefix ? `${prefix}/${entry.name}` : entry.name

      if (entry.isDirectory()) {
        const before = files.length
        await walk(full, at, partial && !included(at))

        // an EMPTY directory would otherwise vanish, since the tree is derived from
        // file paths. Record it explicitly so a checkout can recreate it. Git cannot
        // represent this at all.
        if (files.length === before) {
          files.push({ path: at, mode: 'dir', size: 0, chunks: [] })
        }

        continue
      }

      if (!entry.isFile()) {
        continue
      }

      const data = await fsp.readFile(full)
      const stat = await fsp.stat(full)
      const mode: EntryMode =
        (stat.mode & 0o111) !== 0 ? 'exec' : 'file'

      // `.tree` is PARSED, not chunked. Its record goes into the dataset, so editing
      // one field costs one record rather than a whole file, and the prolly tree's
      // field-level diff and merge apply to a package's own format.
      // A `.tree` the record grammar cannot hold is kept as bytes. See `recordOf`.
      if (classify({ path: at, bytes: data }) === 'tree') {
        const record = recordOf(data)

        if (record !== undefined) {
          files.push({ path: at, mode, size: data.length, chunks: [], record })

          continue
        }
      }

      const chunks: Array<string> = []

      for (const cut of chunkBuffer({
        data,
        params: input.params,
      })) {
        const slice = data.subarray(cut.start, cut.end)
        const id = hashObject({ kind: 'chunk', bytes: slice })
        await input.store.put({ id, bytes: Buffer.from(slice) })
        chunks.push(id)
      }

      files.push({ path: at, mode, size: data.length, chunks })
    }
  }

  await walk(input.dir, '')

  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))

  return files
}

// The `.tree` as a record, or nothing when the record grammar cannot hold it, and then the file ships as bytes.
//
// Storing a `.tree` as a record is an OPTIMIZATION (a one-field edit costs one record), never a requirement: the
// bytes carry the same file. And the record grammar is not Term's grammar, so a valid Term file can fail it. Three
// shapes did, each failing `term host` for a whole package: a blank file and a comments-only one (`empty .tree
// input`), and a lean `role.tree`, whose `mark lean` the record parser accepts as a record identity and the encoder
// then refuses, needing 32 characters. So the record is ENCODED here as well as parsed, because a parse that
// succeeds says nothing about whether `writeDataset` can write it.
// Whether a `.tree` is valid TERM is `term make`'s question, asked before a publish, not this one.
//
// AND THE RECORD MUST GIVE THE FILE BACK. A checkout writes a record out with `formatTree` (restore.ts), so a record
// is kept only when that writes these exact bytes. The record grammar is a DATA grammar: on Term source it parsed the
// first top-level node and dropped the rest, and comments and blank lines with it, so every published `.tree` file
// came back cut to its first line or block (`@term/bind`'s 337,814-byte dom.tree to 55 bytes, 3,084 of its 3,094
// files changed, found 2026-10-05). A file it cannot give back exactly ships as bytes, which is never wrong.
// test/oci.test.ts "installs Term source byte for byte" holds it.
function recordOf(data: Buffer): ReturnType<typeof parseTree> | undefined {
  try {
    const text = data.toString('utf8')
    const record = parseTree(text)

    canonicalBytes(record)

    return formatTree(record) === text ? record : undefined
  } catch {
    return undefined
  }
}

// Build a version: walk, chunk, and write the prolly tree. The tree's own chunks are
// left in memory for the caller to ship, since only the ones the receiver lacks need
// to move.
export async function buildVersion(input: {
  dir: string
  store: ObjectStore
  params?: ChunkParams
  exclude?: Set<string>
  include?: Array<string>
}): Promise<BuiltVersion> {
  const files = await readVersionFiles(input)
  const treeChunks = new MemoryChunkStore()
  const root = writeDataset(datasetOfFiles(files), treeChunks)

  return { root, files, treeChunks }
}
