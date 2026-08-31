/**
 * Build the object graph for a package directory.
 *
 * Walk the directory, chunk every file into a blob, turn every directory
 * into a tree, and top it with a release object. Every object is written
 * into the given store as it is produced (create-if-absent, so unchanged
 * objects from a previous build are reused, which is the whole dedup
 * story). Returns the release id and the release value (unsigned; signing
 * is a separate step).
 *
 * Chunking is content-defined (see ./chunk), so this handles a three-line
 * text file and a multi-gigabyte binary by the identical path, which is
 * the uniform, transparent, large-blob-native behavior from
 * note/term/registry/11.
 */

import fsp from 'fs/promises'
import path from 'path'
import { chunkBuffer, ChunkParams } from './chunk'
import {
  Blob,
  Commit,
  TreeEntry,
  TreeParams,
  blobId,
  canonicalJson,
  chunkId,
  commitId,
} from './model'
import { buildDirNode } from './tree'
import { ObjectStore } from './store'

// Directories never published (build artifacts, local install, vcs).
const DEFAULT_EXCLUDE = new Set([
  'link',
  '.base/@cluesurf/term',
  '.term',
  'node_modules',
  '.git',
  'host',
  'dist',
])

/** Chunk one file into a blob, store the chunks and the blob, return the blob id. */
export async function buildBlob(input: {
  filePath: string
  store: ObjectStore
  params?: ChunkParams
}): Promise<string> {
  const data = await fsp.readFile(input.filePath)
  const cuts = chunkBuffer({ data, params: input.params })
  const chunks: string[] = []

  for (const cut of cuts) {
    const slice = data.subarray(cut.start, cut.end)
    const id = chunkId(slice)
    await input.store.put({ id, bytes: Buffer.from(slice) })
    chunks.push(id)
  }

  const blob: Blob = { chunks, size: data.length }
  const id = blobId(blob)
  await input.store.put({
    id,
    bytes: Buffer.from(canonicalJson(blob), 'utf8'),
  })

  return id
}

/** Walk a directory into a tree, store every object, return the tree id. */
export async function buildTree(input: {
  dir: string
  store: ObjectStore
  params?: ChunkParams
  treeParams?: TreeParams
  exclude?: Set<string>
}): Promise<string> {
  const exclude = input.exclude ?? DEFAULT_EXCLUDE
  const dirents = await fsp.readdir(input.dir, { withFileTypes: true })
  const entries: TreeEntry[] = []

  for (const dirent of dirents) {
    if (exclude.has(dirent.name)) {
      continue
    }

    if (dirent.name.startsWith('.') && dirent.name !== '.treeignore') {
      // skip dotfiles by default, matching the tarball publisher
      continue
    }

    const full = path.join(input.dir, dirent.name)

    if (dirent.isDirectory()) {
      const id = await buildTree({
        dir: full,
        store: input.store,
        params: input.params,
        treeParams: input.treeParams,
        exclude,
      })
      entries.push({ id, kind: 'tree', mode: 'dir', name: dirent.name })
    } else if (dirent.isFile()) {
      const id = await buildBlob({
        filePath: full,
        store: input.store,
        params: input.params,
      })
      const stat = await fsp.stat(full)
      const isExec = (stat.mode & 0o111) !== 0
      entries.push({
        id,
        kind: 'blob',
        mode: isExec ? 'exec' : 'file',
        name: dirent.name,
      })
    }
    // symlinks and other kinds are skipped (see the checkout threat model)
  }

  return buildDirNode({
    entries,
    store: input.store,
    params: input.treeParams,
  })
}

/**
 * Build a commit for a package directory: a content-addressed snapshot of
 * its files, linked to its parent commit(s). `time` is passed in (not read
 * from the clock) so builds are reproducible and the caller owns the
 * timestamp. Every save produces one of these (see note/term/registry/14).
 */
export async function buildCommit(input: {
  dir: string
  package: string
  deps: Record<string, string>
  author: string
  time: string
  message?: string
  parents?: string[]
  store: ObjectStore
  params?: ChunkParams
  treeParams?: TreeParams
}): Promise<{ commitId: string; commit: Commit }> {
  const tree = await buildTree({
    dir: input.dir,
    store: input.store,
    params: input.params,
    treeParams: input.treeParams,
  })

  // manifest: the blob id of deck.tree, a quick handle on the manifest file
  const manifest = await buildBlob({
    filePath: path.join(input.dir, 'deck.tree'),
    store: input.store,
    params: input.params,
  })

  const commit: Commit = {
    author: input.author,
    deps: input.deps,
    manifest,
    message: input.message ?? '',
    package: input.package,
    parents: input.parents ?? [],
    time: input.time,
    tree,
  }

  const id = commitId(commit)
  await input.store.put({
    id,
    bytes: Buffer.from(canonicalJson(commit), 'utf8'),
  })

  return { commitId: id, commit }
}
