/**
 * Prolly-tree directory nodes: build a content-defined B-tree over a
 * directory's entries, read it back, and walk its node closure.
 *
 * A directory's entries are sorted, then chunked into leaf nodes at
 * content-defined boundaries (an entry ends a node when its own id is a
 * boundary, so ~1 in avgFanout entries is a boundary). The resulting leaf
 * references are themselves chunked into inner nodes, and so up until one
 * root node remains. Because a boundary depends only on the item's
 * content hash, the structure is history-independent (the same entries
 * always produce the same nodes) and a change to one entry re-stores only
 * the node holding it plus the O(log n) nodes on its path. A small
 * directory is a single leaf, so there is no overhead until a directory is
 * large (see note/term/registry/15 and 16).
 */

import {
  LeafNode,
  InnerNode,
  NodeRef,
  TreeEntry,
  TreeNode,
  TreeParams,
  DEFAULT_TREE_PARAMS,
  canonicalJson,
  isLeafNode,
  isNodeBoundary,
  nodeId,
  sortEntries,
  validateEntries,
} from './model'
import { ObjectStore } from './store'

async function putNode(node: TreeNode, store: ObjectStore): Promise<string> {
  const id = nodeId(node)
  await store.put({ id, bytes: Buffer.from(canonicalJson(node), 'utf8') })

  return id
}

/** Chunk a sorted entry list into leaf nodes, returning their refs in order. */
async function chunkEntries(input: {
  entries: TreeEntry[]
  store: ObjectStore
  params: TreeParams
}): Promise<NodeRef[]> {
  const refs: NodeRef[] = []
  let current: TreeEntry[] = []

  const flush = async (): Promise<void> => {
    if (current.length === 0) {
      return
    }

    const node: LeafNode = { entries: current, level: 0 }
    const id = await putNode(node, input.store)
    refs.push({ id, key: current[0]!.name })
    current = []
  }

  for (const entry of input.entries) {
    current.push(entry)

    const atMax = current.length >= input.params.max
    const boundary = isNodeBoundary(entry.id, input.params.avgFanout)

    if (atMax || boundary) {
      await flush()
    }
  }

  await flush()

  return refs
}

/** Chunk a list of node refs into inner nodes one level up. */
async function chunkRefs(input: {
  refs: NodeRef[]
  level: number
  store: ObjectStore
  params: TreeParams
}): Promise<NodeRef[]> {
  const out: NodeRef[] = []
  let current: NodeRef[] = []

  const flush = async (): Promise<void> => {
    if (current.length === 0) {
      return
    }

    const node: InnerNode = { level: input.level, refs: current }
    const id = await putNode(node, input.store)
    out.push({ id, key: current[0]!.key })
    current = []
  }

  for (const ref of input.refs) {
    current.push(ref)

    const atMax = current.length >= input.params.max
    const boundary = isNodeBoundary(ref.id, input.params.avgFanout)

    if (atMax || boundary) {
      await flush()
    }
  }

  await flush()

  return out
}

/**
 * Build a directory's prolly tree from its entries and store every node.
 * Returns the root node id (the directory's "tree id").
 */
export async function buildDirNode(input: {
  entries: TreeEntry[]
  store: ObjectStore
  params?: TreeParams
}): Promise<string> {
  const params = input.params ?? DEFAULT_TREE_PARAMS
  const entries = sortEntries(input.entries)
  const reason = validateEntries(entries)

  if (reason) {
    throw new Error(`invalid directory entries: ${reason}`)
  }

  // empty directory: a single empty leaf
  if (entries.length === 0) {
    return putNode({ entries: [], level: 0 }, input.store)
  }

  let refs = await chunkEntries({ entries, store: input.store, params })
  let level = 1

  while (refs.length > 1) {
    refs = await chunkRefs({ refs, level, store: input.store, params })
    level += 1
  }

  return refs[0]!.id
}

async function readNode(
  store: ObjectStore,
  id: string,
): Promise<TreeNode> {
  const bytes = await store.get(id)

  return JSON.parse(bytes.toString('utf8')) as TreeNode
}

/**
 * Read a directory's full ordered entry list by walking its prolly tree
 * from the root node down to the leaves.
 */
export async function readDirEntries(input: {
  nodeId: string
  store: ObjectStore
}): Promise<TreeEntry[]> {
  const node = await readNode(input.store, input.nodeId)

  if (isLeafNode(node)) {
    return node.entries
  }

  const out: TreeEntry[] = []

  for (const ref of node.refs) {
    out.push(
      ...(await readDirEntries({ nodeId: ref.id, store: input.store })),
    )
  }

  return out
}

/**
 * Collect every node id in a directory's prolly tree (all inner and leaf
 * nodes), for the object closure. Does not descend into child directories
 * or blobs; the caller handles those from the returned entries.
 */
export async function dirNodeIds(input: {
  nodeId: string
  store: ObjectStore
  into: Set<string>
}): Promise<void> {
  if (input.into.has(input.nodeId)) {
    return
  }

  input.into.add(input.nodeId)
  const node = await readNode(input.store, input.nodeId)

  if (!isLeafNode(node)) {
    for (const ref of node.refs) {
      await dirNodeIds({
        nodeId: ref.id,
        store: input.store,
        into: input.into,
      })
    }
  }
}
