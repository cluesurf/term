/**
 * The object model: chunk, blob, tree, release, and their canonical
 * serialization and content addresses.
 *
 * Content addressing only works if the client and server serialize and
 * hash identically, byte for byte. This file is the single definition of
 * that format. It is frozen by the contract in note/term/registry/12 and
 * must be mirrored exactly on the server. Everything serializes to
 * canonical JSON (keys sorted, no insignificant whitespace) and is
 * addressed with the domain-separated hash in ./hash.
 */

import { hashObject, hashObjectText, isObjectId } from './hash'

/** A file's entry mode. Deliberately a tiny allowlist. */
export type EntryMode = 'file' | 'exec' | 'dir'

/** A blob is one file of any size: an ordered list of chunk ids plus the total size. */
export type Blob = {
  chunks: string[]
  size: number
}

/** One entry in a directory listing. */
export type TreeEntry = {
  id: string
  kind: 'blob' | 'tree'
  mode: EntryMode
  name: string
}

/**
 * A directory is a prolly tree (a content-defined B-tree) of its entries,
 * so a very wide directory dedups at the node level: changing one of many
 * thousands of entries re-stores only the leaf holding it plus the
 * O(log n) inner nodes on its path, not the whole listing (see
 * note/term/registry/15 and 16).
 *
 * A directory node is either a LEAF holding a content-defined run of
 * entries, or an INNER node holding references to child nodes. A small
 * directory is a single leaf, identical in cost to a plain listing, so
 * there is zero overhead until a directory is genuinely large.
 *
 * The "tree id" of a directory is the id of its ROOT node. A `tree`-kind
 * TreeEntry points at the root node of a child directory. Both kinds of
 * nesting (child directories, and prolly sub-nodes within one directory)
 * are the same kind of object.
 */

/** A reference from an inner node to a child node, keyed by the child's least entry name. */
export type NodeRef = {
  id: string
  key: string
}

/** A leaf directory node: a content-defined run of entries, sorted by name. */
export type LeafNode = {
  entries: TreeEntry[]
  level: 0
}

/** An inner directory node: references to child nodes, in key order. */
export type InnerNode = {
  level: number
  refs: NodeRef[]
}

/** A directory node: leaf or inner. */
export type TreeNode = LeafNode | InnerNode

export function isLeafNode(node: TreeNode): node is LeafNode {
  return node.level === 0
}

/**
 * A commit: a content-addressed snapshot of a package's files at one
 * point, with links to its parent commit(s). This is the git-commit
 * analogue and the unit of every save (see note/term/registry/14). A
 * published version is a signed tag over a commit; a branch is a mutable
 * pointer to a commit. Both live in the ref store, not here.
 */
export type Commit = {
  author: string
  deps: Record<string, string>
  manifest: string
  message: string
  package: string
  parents: string[]
  time: string
  tree: string
}

/**
 * Canonical JSON: object keys sorted lexicographically at every level, no
 * insignificant whitespace, arrays kept in their given order. This is the
 * exact byte form that gets hashed, so it must be deterministic.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`
  }

  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map(key => {
    const child = (value as Record<string, unknown>)[key]

    return `${JSON.stringify(key)}:${canonicalJson(child)}`
  })

  return `{${parts.join(',')}}`
}

/** The id of a chunk, addressing its raw bytes. */
export function chunkId(bytes: Buffer): string {
  return hashObject({ kind: 'chunk', bytes })
}

/** The id of a blob, addressing its canonical form. */
export function blobId(blob: Blob): string {
  return hashObjectText({ kind: 'blob', text: canonicalJson(blob) })
}

/** The id of a directory node (leaf or inner), addressing its canonical form. */
export function nodeId(node: TreeNode): string {
  return hashObjectText({ kind: 'tree', text: canonicalJson(node) })
}

/** The id of a commit, addressing its canonical form (the value the signature covers). */
export function commitId(commit: Commit): string {
  return hashObjectText({
    kind: 'commit',
    text: canonicalJson(commit),
  })
}

/** Sort entries by name in byte order, the canonical order. */
export function sortEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
}

/**
 * Prolly-tree chunking parameters for a directory listing. `avgFanout` is
 * the target children per node; `min`/`max` bound node size so no node is
 * degenerate. Internal, never user-facing.
 */
export type TreeParams = {
  avgFanout: number
  min: number
  max: number
}

export const DEFAULT_TREE_PARAMS: TreeParams = {
  avgFanout: 64,
  min: 16,
  max: 256,
}

/** A stable 32-bit number derived from an object id, for boundary decisions. */
export function idNumber(id: string): number {
  // take 8 hex chars after the `sha256:` prefix
  const hex = id.slice(7, 15)

  return parseInt(hex, 16) >>> 0
}

/**
 * Is this id a content-defined node boundary at the given average fanout?
 * True for roughly 1 in `avgFanout` ids, chosen by the id's own hash, so
 * boundaries depend only on content and are history-independent (the same
 * items always chunk into the same nodes).
 */
export function isNodeBoundary(id: string, avgFanout: number): boolean {
  const bits = Math.max(1, Math.round(Math.log2(avgFanout)))
  const mask = (1 << bits) - 1

  return (idNumber(id) & mask) === 0
}

// Reserved device names that are unsafe as path components on some hosts.
const RESERVED_NAMES = new Set([
  'con',
  'prn',
  'aux',
  'nul',
  'com1',
  'com2',
  'com3',
  'com4',
  'lpt1',
  'lpt2',
  'lpt3',
])

/**
 * Validate a tree-entry name. Rejects anything that could escape the
 * package directory or collide ambiguously on checkout (see the checkout
 * threats in note/term/registry/07). Returns null if valid, else a reason.
 */
export function validateEntryName(name: string): string | null {
  if (name.length === 0) {
    return 'empty name'
  }

  if (name === '.' || name === '..') {
    return 'dot name'
  }

  if (name.includes('/') || name.includes('\\')) {
    return 'path separator in name'
  }

  if (name.includes('\0')) {
    return 'null byte in name'
  }

  if (RESERVED_NAMES.has(name.toLowerCase())) {
    return 'reserved device name'
  }

  return null
}

/**
 * Validate a directory's entries: names are valid and unique under
 * case-fold plus Unicode NFC (so no two entries collide on a normalizing
 * or case-insensitive filesystem), ids are well formed, and modes match
 * kind. Returns null if valid, else a reason. Enforced at publish and
 * checkout. Operates on the fully-assembled entry list of a directory
 * (across all prolly-tree leaves).
 */
export function validateEntries(entries: TreeEntry[]): string | null {
  const seen = new Set<string>()

  for (const entry of entries) {
    const nameReason = validateEntryName(entry.name)

    if (nameReason) {
      return `${entry.name}: ${nameReason}`
    }

    if (!isObjectId(entry.id)) {
      return `${entry.name}: malformed id`
    }

    if (entry.kind === 'tree' && entry.mode !== 'dir') {
      return `${entry.name}: tree entry must have dir mode`
    }

    if (entry.kind === 'blob' && entry.mode === 'dir') {
      return `${entry.name}: blob entry cannot have dir mode`
    }

    const normal = entry.name.normalize('NFC').toLowerCase()

    if (seen.has(normal)) {
      return `${entry.name}: name collides under normalization`
    }

    seen.add(normal)
  }

  return null
}
