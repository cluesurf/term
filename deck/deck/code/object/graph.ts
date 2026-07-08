/**
 * Walking the object DAG: computing a commit's full object closure (for
 * the publish handshake) and flattening a tree into the consumption
 * manifest (for resolve and UIs).
 *
 * The closure is every object reachable from a commit: the commit, its
 * tree and subtrees, every blob, and every chunk. The publish negotiate
 * step sends this id set so the server can reply with the missing subset
 * (see note/term/registry/04). The manifest is the flat file listing a UI
 * consumes (see note/term/registry/14).
 */

import { Blob, Commit, validateEntries } from './model'
import { readDirEntries, dirNodeIds } from './tree'
import { ObjectStore } from './store'

async function readJson<T>(store: ObjectStore, id: string): Promise<T> {
  const bytes = await store.get(id)

  return JSON.parse(bytes.toString('utf8')) as T
}

/**
 * Every object id reachable from a directory tree: all of its prolly
 * nodes (inner and leaf), its child directory trees, its blobs, and their
 * chunks.
 */
export async function treeClosure(input: {
  treeId: string
  store: ObjectStore
  into?: Set<string>
}): Promise<Set<string>> {
  const ids = input.into ?? new Set<string>()

  if (ids.has(input.treeId)) {
    return ids
  }

  // add every prolly node id of this directory's listing
  await dirNodeIds({ nodeId: input.treeId, store: input.store, into: ids })

  const entries = await readDirEntries({
    nodeId: input.treeId,
    store: input.store,
  })

  for (const entry of entries) {
    if (entry.kind === 'tree') {
      await treeClosure({ treeId: entry.id, store: input.store, into: ids })
    } else {
      ids.add(entry.id)
      const blob = await readJson<Blob>(input.store, entry.id)

      for (const chunk of blob.chunks) {
        ids.add(chunk)
      }
    }
  }

  return ids
}

/** Every object id reachable from a commit (commit + manifest blob + tree closure). */
export async function commitClosure(input: {
  commitId: string
  store: ObjectStore
}): Promise<Set<string>> {
  const ids = new Set<string>([input.commitId])
  const commit = await readJson<Commit>(input.store, input.commitId)

  ids.add(commit.manifest)
  const blob = await readJson<Blob>(input.store, commit.manifest)

  for (const chunk of blob.chunks) {
    ids.add(chunk)
  }

  await treeClosure({ treeId: commit.tree, store: input.store, into: ids })

  return ids
}

/** One file in the flat manifest. */
export type ManifestFile = {
  path: string
  blob: string
  size: number
  mode: 'file' | 'exec'
}

/** The flat manifest: every file in a commit, path to blob id and size. */
export type Manifest = {
  package: string
  ref: string
  files: ManifestFile[]
}

// one file's identity before its size is looked up
type FileRef = { path: string; blob: string; mode: 'file' | 'exec' }

// Walk the tree collecting every file's (path, blob id, mode) WITHOUT reading
// blob objects; subtrees walk concurrently while the flat list keeps the
// original depth-first order.
async function collectFiles(input: {
  treeId: string
  store: ObjectStore
  prefix?: string
}): Promise<FileRef[]> {
  const prefix = input.prefix ?? ''
  const entries = await readDirEntries({
    nodeId: input.treeId,
    store: input.store,
  })
  const reason = validateEntries(entries)

  if (reason) {
    throw new Error(`invalid tree ${input.treeId}: ${reason}`)
  }

  const parts: (FileRef[] | Promise<FileRef[]>)[] = entries.map(entry => {
    const childPath = prefix ? `${prefix}/${entry.name}` : entry.name

    if (entry.kind === 'tree') {
      return collectFiles({
        treeId: entry.id,
        store: input.store,
        prefix: childPath,
      })
    }

    return [
      {
        path: childPath,
        blob: entry.id,
        mode: entry.mode === 'exec' ? 'exec' : 'file',
      },
    ]
  })

  return (await Promise.all(parts)).flat()
}

const SIZE_READ_CONCURRENCY = 100

/**
 * Flatten a tree into a sorted flat file list. The tree is walked to collect
 * file refs (concurrent by subtree, depth-first order preserved), then blob
 * sizes are read in bounded parallel batches — turning ~93k serial reads
 * (which time out) into a fast concurrent pass.
 */
export async function flattenTree(input: {
  treeId: string
  store: ObjectStore
  prefix?: string
}): Promise<ManifestFile[]> {
  const refs = await collectFiles(input)
  const files: ManifestFile[] = new Array(refs.length)

  for (let i = 0; i < refs.length; i += SIZE_READ_CONCURRENCY) {
    const batch = refs.slice(i, i + SIZE_READ_CONCURRENCY)
    const sizes = await Promise.all(
      batch.map(ref =>
        readJson<Blob>(input.store, ref.blob).then(blob => blob.size),
      ),
    )

    batch.forEach((ref, j) => {
      files[i + j] = {
        path: ref.path,
        blob: ref.blob,
        size: sizes[j]!,
        mode: ref.mode,
      }
    })
  }

  return files
}

/** Build the flat manifest for a commit under a given ref label. */
export async function buildManifest(input: {
  commitId: string
  ref: string
  store: ObjectStore
}): Promise<Manifest> {
  const commit = await readJson<Commit>(input.store, input.commitId)
  const files = await flattenTree({ treeId: commit.tree, store: input.store })

  return {
    package: commit.package,
    ref: input.ref,
    files,
  }
}
