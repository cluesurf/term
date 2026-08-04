import type { Mark, RecordNode } from '@/base/type'
import { canonicalizeRecord } from '@/canon/canonicalize'
import { canonicalString } from '@/canon/json'
import { decodeRecord } from '@/canon/decode'
import type { Dataset } from '@/diff/change'
import type { ChunkStore } from '@/store/chunk-store'

// A content-addressed prolly tree over records keyed by mark. Records are stored as
// chunks by their canonical hash (so equal records dedup). The tree indexes them,
// sorted by mark and content-defined-chunked into leaves and branches, so a state
// is named by one root hash, unchanged subtrees are shared across versions, and a
// diff prunes identical subtrees by hash rather than scanning everything.
//
// See note/library/base/14-storage-substrate.md.

type Entry = [Mark, string] // [mark, recordHash]  or  [minMark, childHash]
type Node =
  | { kind: 'L'; entries: Array<Entry> }
  | { kind: 'B'; children: Array<Entry> }

// Content-defined chunk boundary: end a chunk after an entry whose hash ends in a
// low-bit pattern (probabilistic, average size ~1/PROB), or when a size cap is hit.
const BOUNDARY_MASK = 0x3
const MAX_CHUNK = 16

function lastByte(hash: string): number {
  const hex = hash.slice(-2)
  return parseInt(hex, 16)
}

function isBoundary(hash: string): boolean {
  return (lastByte(hash) & BOUNDARY_MASK) === 0
}

function chunk(entries: Array<Entry>): Array<Array<Entry>> {
  const groups: Array<Array<Entry>> = []
  let cur: Array<Entry> = []
  for (const e of entries) {
    cur.push(e)
    if (cur.length >= MAX_CHUNK || isBoundary(e[1])) {
      groups.push(cur)
      cur = []
    }
  }
  if (cur.length) {
    groups.push(cur)
  }
  return groups
}

function storeNode(node: Node, store: ChunkStore): string {
  const canon: Array<unknown> =
    node.kind === 'L' ? ['L', node.entries] : ['B', node.children]
  return store.put(canonicalString(canon as never))
}

function loadNode(hash: string, store: ChunkStore): Node {
  const bytes = store.get(hash)
  if (bytes === undefined) {
    throw new Error(`missing chunk ${hash}`)
  }
  return decodeNode(bytes)
}

function decodeNode(bytes: string): Node {
  const arr = JSON.parse(bytes) as [string, Array<Entry>]
  return arr[0] === 'L'
    ? { kind: 'L', entries: arr[1] }
    : { kind: 'B', children: arr[1] }
}

// The hashes a tree node points at, from its stored bytes: record chunks for a leaf,
// child nodes for a branch. Lets an async store walk the tree without the sync store
// interface. `leaf` refs are terminal (record chunks); branch refs are more nodes.
export function treeNodeRefs(bytes: string): { leaf: boolean; refs: Array<string> } {
  const node = decodeNode(bytes)
  return node.kind === 'L'
    ? { leaf: true, refs: node.entries.map(e => e[1]) }
    : { leaf: false, refs: node.children.map(e => e[1]) }
}

function buildLevel(
  entries: Array<Entry>,
  kind: 'L' | 'B',
  store: ChunkStore,
): Array<Entry> {
  const parents: Array<Entry> = []
  for (const group of chunk(entries)) {
    const node: Node =
      kind === 'L' ? { kind: 'L', entries: group } : { kind: 'B', children: group }
    const hash = storeNode(node, store)
    parents.push([group[0]![0], hash])
  }
  return parents
}

// Build a tree from sorted entries, return the root hash.
function writeTree(entries: Array<Entry>, store: ChunkStore): string {
  if (entries.length === 0) {
    return storeNode({ kind: 'L', entries: [] }, store)
  }
  let level = entries
  let kind: 'L' | 'B' = 'L'
  for (;;) {
    const parents = buildLevel(level, kind, store)
    if (parents.length === 1) {
      return parents[0]![1]
    }
    level = parents
    kind = 'B'
  }
}

// Write a whole dataset: store each record, then build the index tree.
export function writeDataset(dataset: Dataset, store: ChunkStore): string {
  const entries: Array<Entry> = []
  for (const [mark, record] of dataset) {
    const hash = store.put(canonicalizeRecord(record))
    entries.push([mark, hash])
  }
  entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
  return writeTree(entries, store)
}

// Collect every (mark, recordHash) under a subtree.
function collectEntries(
  hash: string,
  store: ChunkStore,
  into: Map<Mark, string>,
): void {
  const node = loadNode(hash, store)
  if (node.kind === 'L') {
    for (const [mark, rh] of node.entries) {
      into.set(mark, rh)
    }
  } else {
    for (const [, childHash] of node.children) {
      collectEntries(childHash, store, into)
    }
  }
}

// Incrementally update a tree from a parent root: only the changed records are
// canonicalized and hashed, and unchanged record chunks are reused by hash. This is
// what a commit uses so committing one change to a large dataset does not
// re-canonicalize every record. (The index rebuild is still linear in the entry
// count but cheap, since it only rehashes small entries; a fully incremental leaf
// splice is a further optimization.)
export function updateTree(
  parentRoot: string,
  upserts: Map<Mark, RecordNode>,
  removes: Set<Mark>,
  store: ChunkStore,
): string {
  const entries = new Map<Mark, string>()
  collectEntries(parentRoot, store, entries)
  for (const [mark, record] of upserts) {
    entries.set(mark, store.put(canonicalizeRecord(record)))
  }
  for (const mark of removes) {
    entries.delete(mark)
  }
  const sorted: Array<Entry> = [...entries.entries()].sort((a, b) =>
    a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
  )
  return writeTree(sorted, store)
}

// Read a dataset back from a root hash.
export function readDataset(root: string, store: ChunkStore): Dataset {
  const entries = new Map<Mark, string>()
  collectEntries(root, store, entries)
  const out: Dataset = new Map()
  for (const [mark, rh] of entries) {
    const bytes = store.get(rh)
    if (bytes === undefined) {
      throw new Error(`missing record chunk ${rh}`)
    }
    out.set(mark, decodeRecord(bytes))
  }
  return out
}

// Every node hash reachable from a root (branches and leaves).
function allNodeHashes(
  hash: string,
  store: ChunkStore,
  into: Set<string>,
): void {
  if (into.has(hash)) {
    return
  }
  into.add(hash)
  const node = loadNode(hash, store)
  if (node.kind === 'B') {
    for (const [, childHash] of node.children) {
      allNodeHashes(childHash, store, into)
    }
  }
}

// Collect leaf entries under a subtree, pruning any node whose hash appears in the
// other tree (a shared subtree, whose entries cannot have changed).
function collectUnshared(
  hash: string,
  other: Set<string>,
  store: ChunkStore,
  into: Map<Mark, string>,
): void {
  if (other.has(hash)) {
    return // shared subtree: pruned, so shared records are never even read
  }
  const node = loadNode(hash, store)
  if (node.kind === 'L') {
    for (const [mark, rh] of node.entries) {
      into.set(mark, rh)
    }
  } else {
    for (const [, childHash] of node.children) {
      collectUnshared(childHash, other, store, into)
    }
  }
}

// Every chunk hash reachable from a root: the tree nodes and the record chunks they
// point at. This is what a sync transfers, and what a snapshot consists of.
export function collectChunkHashes(
  root: string,
  store: ChunkStore,
  into: Set<string> = new Set(),
): Set<string> {
  if (into.has(root)) {
    return into
  }
  into.add(root)
  const node = loadNode(root, store)
  if (node.kind === 'L') {
    for (const [, recordHash] of node.entries) {
      into.add(recordHash)
    }
  } else {
    for (const [, childHash] of node.children) {
      collectChunkHashes(childHash, store, into)
    }
  }
  return into
}

// The chunk hashes reachable from a root that a receiver lacks, pruning any subtree
// whose node the receiver already has. Because a node hash implies its whole
// subtree, a shared subtree is skipped without descending, so the work tracks the
// size of the difference. This is what makes replica sync O(diff), not O(dataset).
export function collectMissingChunks(
  root: string,
  store: ChunkStore,
  has: (hash: string) => boolean,
  into: Set<string> = new Set(),
): Set<string> {
  if (has(root)) {
    return into // receiver has this node and its entire subtree
  }
  into.add(root)
  const node = loadNode(root, store)
  if (node.kind === 'L') {
    for (const [, recordHash] of node.entries) {
      if (!has(recordHash)) {
        into.add(recordHash)
      }
    }
  } else {
    for (const [, childHash] of node.children) {
      collectMissingChunks(childHash, store, has, into)
    }
  }
  return into
}

// Point lookup: fetch a single record by mark from a root, walking root to leaf in
// logarithmic steps, without materializing the tree. This is what lets a client
// read one record without a checkout (live mode).
export function readRecord(
  root: string,
  mark: Mark,
  store: ChunkStore,
): RecordNode | undefined {
  let hash = root
  for (;;) {
    const node = loadNode(hash, store)
    if (node.kind === 'L') {
      const entry = node.entries.find(e => e[0] === mark)
      if (entry === undefined) {
        return undefined
      }
      const bytes = store.get(entry[1])
      return bytes === undefined ? undefined : decodeRecord(bytes)
    }
    let chosen = node.children[0]!
    for (const child of node.children) {
      if (child[0] <= mark) {
        chosen = child
      } else {
        break
      }
    }
    hash = chosen[1]
  }
}

// Ordered merge of two leaves' entries by mark: a mark on one side only changed
// (added or removed); a mark on both sides changed iff its record hash differs.
function diffLeafEntries(
  ea: Array<Entry>,
  eb: Array<Entry>,
  changed: Set<Mark>,
): void {
  let i = 0
  let j = 0
  while (i < ea.length || j < eb.length) {
    if (j >= eb.length || (i < ea.length && ea[i]![0] < eb[j]![0])) {
      changed.add(ea[i]![0]) // present only in A: removed
      i++
    } else if (i >= ea.length || eb[j]![0] < ea[i]![0]) {
      changed.add(eb[j]![0]) // present only in B: added
      j++
    } else {
      if (ea[i]![1] !== eb[j]![1]) {
        changed.add(ea[i]![0]) // same mark, differing record hash: edited
      }
      i++
      j++
    }
  }
}

// Two branches are aligned when their children partition the key space identically
// (same count, same min-keys). An edit that does not move a chunk boundary keeps the
// branch aligned, with only the child hashes that changed differing, which is the
// overwhelming majority of edits since chunk boundaries are content-defined.
function branchesAligned(ca: Array<Entry>, cb: Array<Entry>): boolean {
  if (ca.length !== cb.length) {
    return false
  }
  for (let k = 0; k < ca.length; k++) {
    if (ca[k]![0] !== cb[k]![0]) {
      return false
    }
  }
  return true
}

// The changed region between two subtrees, walking both in lockstep. Identical
// subtrees (equal hash) are skipped without being read, so the work tracks the size
// of the difference rather than the dataset. When a boundary shift misaligns two
// branches (rare), it falls back to a correct hash-set comparison for that subtree.
function diffSubtrees(
  ha: string,
  hb: string,
  store: ChunkStore,
  changed: Set<Mark>,
): void {
  if (ha === hb) {
    return // identical subtree: nothing changed under here
  }
  const a = loadNode(ha, store)
  const b = loadNode(hb, store)
  if (a.kind === 'L' && b.kind === 'L') {
    diffLeafEntries(a.entries, b.entries, changed)
    return
  }
  if (a.kind === 'B' && b.kind === 'B' && branchesAligned(a.children, b.children)) {
    for (let k = 0; k < a.children.length; k++) {
      diffSubtrees(a.children[k]![1], b.children[k]![1], store, changed)
    }
    return
  }
  // Height mismatch or a moved boundary: compare this subtree by hash-set pruning,
  // which is correct regardless of structure and stays local to the changed region.
  fallbackDiff(ha, hb, store, changed)
}

// A correct, structure-agnostic diff of two subtrees: prune shared nodes by hash,
// then compare the unshared leaf entries. Used only where lockstep alignment breaks.
function fallbackDiff(
  ha: string,
  hb: string,
  store: ChunkStore,
  changed: Set<Mark>,
): void {
  const hashesA = new Set<string>()
  const hashesB = new Set<string>()
  allNodeHashes(ha, store, hashesA)
  allNodeHashes(hb, store, hashesB)

  const partialA = new Map<Mark, string>()
  const partialB = new Map<Mark, string>()
  collectUnshared(ha, hashesB, store, partialA)
  collectUnshared(hb, hashesA, store, partialB)

  const marks = new Set<Mark>([...partialA.keys(), ...partialB.keys()])
  for (const mark of marks) {
    if (partialA.get(mark) !== partialB.get(mark)) {
      changed.add(mark)
    }
  }
}

// The set of marks whose record changed between two roots, in O(size of the
// difference): identical subtrees are skipped by hash, so shared records are never
// read, and only the differing region is walked.
export function diffRoots(
  rootA: string,
  rootB: string,
  store: ChunkStore,
): Set<Mark> {
  const changed = new Set<Mark>()
  diffSubtrees(rootA, rootB, store, changed)
  return changed
}
