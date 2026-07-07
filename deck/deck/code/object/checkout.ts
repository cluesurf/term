/**
 * Materialize an object graph back onto disk.
 *
 * Reassemble each blob by concatenating its chunks in order, and write
 * the tree out as real directories and files. Every step re-validates
 * against the object model and the checkout threat model (name and path
 * checks, size check, containment), so a correctly-hashed but malicious
 * object still cannot escape the destination (see note/term/registry/07).
 *
 * This is the inverse of ./build. build(dir) then checkout(dir') must
 * produce byte-identical files, for text and for large binaries alike.
 */

import fsp from 'fs/promises'
import path from 'path'
import { Blob, Commit, validateEntries } from './model'
import { readDirEntries } from './tree'
import { ObjectStore } from './store'
import { isObjectId } from './hash'

/** Read and JSON-parse an object from the store. */
async function readJson<T>(store: ObjectStore, id: string): Promise<T> {
  const bytes = await store.get(id)

  return JSON.parse(bytes.toString('utf8')) as T
}

/** Reassemble a blob's bytes by concatenating its chunks in order. */
export async function reassembleBlob(input: {
  blobId: string
  store: ObjectStore
}): Promise<Buffer> {
  const blob = await readJson<Blob>(input.store, input.blobId)
  const parts: Buffer[] = []

  for (const chunk of blob.chunks) {
    if (!isObjectId(chunk)) {
      throw new Error(`blob ${input.blobId} has malformed chunk id`)
    }

    parts.push(await input.store.get(chunk))
  }

  const data = Buffer.concat(parts)

  if (data.length !== blob.size) {
    throw new Error(
      `blob ${input.blobId} size mismatch: expected ${blob.size}, got ${data.length}`,
    )
  }

  return data
}

/** Assert that writing `name` under `dest` stays inside `dest`. */
function assertContained(dest: string, name: string): string {
  const target = path.join(dest, name)
  const resolvedDest = path.resolve(dest)
  const resolvedTarget = path.resolve(target)

  if (
    resolvedTarget !== resolvedDest &&
    !resolvedTarget.startsWith(resolvedDest + path.sep)
  ) {
    throw new Error(`entry '${name}' escapes the destination`)
  }

  return target
}

/** Write a tree out as directories and files under `dest`. */
export async function checkoutTree(input: {
  treeId: string
  dest: string
  store: ObjectStore
}): Promise<void> {
  const entries = await readDirEntries({
    nodeId: input.treeId,
    store: input.store,
  })
  const reason = validateEntries(entries)

  if (reason) {
    throw new Error(`invalid tree ${input.treeId}: ${reason}`)
  }

  await fsp.mkdir(input.dest, { recursive: true })

  for (const entry of entries) {
    const target = assertContained(input.dest, entry.name)

    if (entry.kind === 'tree') {
      await checkoutTree({
        treeId: entry.id,
        dest: target,
        store: input.store,
      })
    } else {
      const data = await reassembleBlob({
        blobId: entry.id,
        store: input.store,
      })
      await fsp.writeFile(target, data)

      if (entry.mode === 'exec') {
        await fsp.chmod(target, 0o755)
      } else {
        await fsp.chmod(target, 0o644)
      }
    }
  }
}

/** Check a whole commit out under `dest` by materializing its tree. */
export async function checkoutCommit(input: {
  commitId: string
  dest: string
  store: ObjectStore
}): Promise<Commit> {
  const commit = await readJson<Commit>(input.store, input.commitId)

  await checkoutTree({
    treeId: commit.tree,
    dest: input.dest,
    store: input.store,
  })

  return commit
}
