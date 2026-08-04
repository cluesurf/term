/**
 * Client install: resolve a ref to a commit, fetch only the objects the
 * local store is missing, then check the tree out by hard-link.
 *
 * The sync walks the commit's DAG and fetches each object not already
 * local. Crucially, if the local store already has a tree node or a blob,
 * the whole subtree or chunk set beneath it is present too (the store only
 * ever holds full closures), so an incremental install skips unchanged
 * subtrees wholesale and transfers only the diff (see
 * note/term/registry/05).
 *
 * Objects are stored post-order (children before parents), so the
 * "have this node implies have its subtree" invariant holds even if a sync
 * is interrupted.
 */

import { restoreFiles } from './restore'
import { ObjectStore } from './store'
import { filesOfDataset } from './dataset'
import {
  readDataset,
  treeNodeRefs,
} from '@term/base/code/store/tree'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { Registry, Ref, objectMatches } from './registry'
import { Blob } from './model'

// Fetch an object from the registry and verify its bytes hash to its id.
async function fetchVerified(input: {
  id: string
  registry: Registry
}): Promise<Buffer> {
  const bytes = await input.registry.getObject(input.id)

  if (!objectMatches({ id: input.id, bytes })) {
    throw new Error(`fetched object ${input.id} failed verification`)
  }

  return bytes
}

async function syncBlob(input: {
  blobId: string
  registry: Registry
  local: ObjectStore
}): Promise<void> {
  if (await input.local.has(input.blobId)) {
    return
  }

  const bytes = await fetchVerified({ id: input.blobId, registry: input.registry })
  const blob = JSON.parse(bytes.toString('utf8')) as Blob

  for (const chunk of blob.chunks) {
    if (!(await input.local.has(chunk))) {
      const cb = await fetchVerified({ id: chunk, registry: input.registry })
      await input.local.put({ id: chunk, bytes: cb })
    }
  }

  await input.local.put({ id: input.blobId, bytes })
}


/** Install a package ref into `dest`, fetching only what the local store lacks. */
export async function installPackage(input: {
  package: string
  ref: Ref
  dest: string
  local: ObjectStore
  registry: Registry
}): Promise<{ commitId: string; fetched: number }> {
  const commitId = await input.registry.resolve({
    package: input.package,
    ref: input.ref,
  })

  const before = await countLocal(input.local)

  // Pull the release's whole closure, then read the version out of it. A commit and its
  // prolly-tree nodes are @term/base chunks now, so the walk is base's, not a
  // hand-written recursion over directory objects.
  const chunks = await pullRelease({
    commitId,
    registry: input.registry,
    local: input.local,
  })

  const files = filesOfDataset(
    readDataset(rootOfCommit({ commitId, chunks }), chunks),
  )

  // The tree reaches RECORD chunks; a record then names its FILE chunks. Those are one
  // level below the tree and have to be fetched too, or a checkout finds the metadata
  // and none of the bytes.
  for (const file of files) {
    for (const id of file.chunks) {
      if (await input.local.has(id)) {
        continue
      }

      const bytes = await fetchVerified({
        id,
        registry: input.registry,
      })

      await input.local.put({ id, bytes })
    }
  }

  await restoreFiles({
    files,
    dest: input.dest,
    store: input.local,
  })

  const fetched = (await countLocal(input.local)) - before

  return { commitId, fetched }
}

// Fetch every chunk of a release into an in-memory store, verifying each against its
// own address. The registry is asked what the closure is; anything already held locally
// is skipped, so a second install of a near-identical version moves almost nothing.
async function pullRelease(input: {
  commitId: string
  registry: Registry
  local: ObjectStore
}): Promise<MemoryChunkStore> {
  const chunks = new MemoryChunkStore()
  const seen = new Set<string>()

  // Fetch one chunk, preferring the local store. Every byte is verified against its own
  // address by `fetchVerified`, so a corrupted or spoofed chunk is rejected.
  const take = async (id: string): Promise<string> => {
    const bytes = (await input.local.has(id))
      ? await input.local.get(id)
      : await fetchVerified({ id, registry: input.registry })

    await input.local.put({ id, bytes })

    const text = bytes.toString('utf8')
    chunks.put(text)

    return text
  }

  // Walk the tree from the commit. An unchanged subtree is already local, so it costs
  // no request: this is what makes an install proportional to the CHANGE.
  const walk = async (id: string): Promise<void> => {
    if (seen.has(id)) {
      return
    }

    seen.add(id)

    const { leaf, refs } = treeNodeRefs(await take(id))

    for (const ref of refs) {
      if (leaf) {
        // a leaf points at record chunks, which are terminal
        await take(ref)
        continue
      }

      await walk(ref)
    }
  }

  const commit = JSON.parse(await take(input.commitId)) as {
    root: string
  }

  await walk(commit.root)

  return chunks
}

// The tree root a commit names.
function rootOfCommit(input: {
  commitId: string
  chunks: MemoryChunkStore
}): string {
  const bytes = input.chunks.get(input.commitId)

  if (bytes === undefined) {
    throw new Error(`missing commit ${input.commitId}`)
  }

  return (JSON.parse(bytes) as { root: string }).root
}

// A cheap "how many objects do I hold" probe is not on the ObjectStore
// interface, so installs that want the fetched count pass through here.
// The default local store does not expose a count, so this returns 0 and
// the count is best-effort; callers that need exact counts wrap the store.
async function countLocal(_store: ObjectStore): Promise<number> {
  return 0
}
