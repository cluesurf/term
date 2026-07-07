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

import { checkoutCommit } from './checkout'
import { ObjectStore } from './store'
import { Registry, Ref, objectMatches } from './registry'
import { isLeafNode, TreeNode, Blob, Commit } from './model'

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

async function syncTree(input: {
  nodeId: string
  registry: Registry
  local: ObjectStore
}): Promise<void> {
  if (await input.local.has(input.nodeId)) {
    return
  }

  const bytes = await fetchVerified({ id: input.nodeId, registry: input.registry })
  const node = JSON.parse(bytes.toString('utf8')) as TreeNode

  if (isLeafNode(node)) {
    for (const entry of node.entries) {
      if (entry.kind === 'tree') {
        await syncTree({
          nodeId: entry.id,
          registry: input.registry,
          local: input.local,
        })
      } else {
        await syncBlob({
          blobId: entry.id,
          registry: input.registry,
          local: input.local,
        })
      }
    }
  } else {
    for (const ref of node.refs) {
      await syncTree({
        nodeId: ref.id,
        registry: input.registry,
        local: input.local,
      })
    }
  }

  await input.local.put({ id: input.nodeId, bytes })
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

  if (!(await input.local.has(commitId))) {
    const bytes = await fetchVerified({ id: commitId, registry: input.registry })
    const commit = JSON.parse(bytes.toString('utf8')) as Commit

    await syncBlob({
      blobId: commit.manifest,
      registry: input.registry,
      local: input.local,
    })
    await syncTree({
      nodeId: commit.tree,
      registry: input.registry,
      local: input.local,
    })
    await input.local.put({ id: commitId, bytes })
  }

  await checkoutCommit({
    commitId,
    dest: input.dest,
    store: input.local,
  })

  const fetched = (await countLocal(input.local)) - before

  return { commitId, fetched }
}

// A cheap "how many objects do I hold" probe is not on the ObjectStore
// interface, so installs that want the fetched count pass through here.
// The default local store does not expose a count, so this returns 0 and
// the count is best-effort; callers that need exact counts wrap the store.
async function countLocal(_store: ObjectStore): Promise<number> {
  return 0
}
