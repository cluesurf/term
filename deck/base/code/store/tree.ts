import type { Mark, RecordNode } from '@term/base/code/base/type'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { canonicalString } from '@term/base/code/canon/json'
import { decodeRecord } from '@term/base/code/canon/decode'
import type { Dataset } from '@term/base/code/diff/change'
import type { ChunkStore } from '@term/base/code/store/chunk-store'

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

// Drop every node the two sides have in common. An equal hash is equal content, and a
// mark lives under exactly one subtree, so a shared node's entries cannot have changed
// on either side. Removing it from BOTH keeps the comparison balanced, and it is never
// read. This is the whole basis of an O(change) diff.
function pruneShared(
  fa: Array<Entry>,
  fb: Array<Entry>,
): { a: Array<Entry>; b: Array<Entry> } {
  const inB = new Set(fb.map(e => e[1]))
  const inA = new Set(fa.map(e => e[1]))
  return {
    a: fa.filter(e => !inB.has(e[1])),
    b: fb.filter(e => !inA.has(e[1])),
  }
}

// How many levels a tree stands, following the leftmost spine. Every branch on a level
// has the same depth beneath it, so one descent is enough. Costs one read per level.
function depthOf(hash: string, store: ChunkStore): number {
  let node = loadNode(hash, store)
  let depth = 1
  while (node.kind === 'B') {
    node = loadNode(node.children[0]![1], store)
    depth++
  }
  return depth
}

// Replace every branch in a frontier with its children. Leaves pass through, so a
// frontier that has already bottomed out in places is not disturbed.
function expandLevel(
  frontier: Array<Entry>,
  store: ChunkStore,
): Array<Entry> {
  const next: Array<Entry> = []
  for (const entry of frontier) {
    const node = loadNode(entry[1], store)
    if (node.kind === 'B') {
      next.push(...node.children)
    } else {
      next.push(entry)
    }
  }
  return next
}

// Walk two trees down together as FRONTIERS of nodes rather than in structural
// lockstep, pruning shared hashes at every level.
//
// Structural lockstep cannot be relied on here. Chunk boundaries are content-defined,
// so a single edit changes hashes up the spine and can flip a boundary at the top,
// which adds or removes a whole level: measured at 200 records, an edit took the tree
// from height 5 to height 6. A descent that pairs node with node then meets a leaf on
// one side and a branch on the other and has to give up.
//
// A frontier walk does not care. Each round expands whichever side still has branches,
// leaves pass through untouched, and shared hashes drop out wherever they sit. The two
// sides converge on leaves at their own pace, and reads stay proportional to the number
// of nodes that actually differ.
function diffFrontier(
  rootA: string,
  rootB: string,
  store: ChunkStore,
  changed: Set<Mark>,
): void {
  let a: Array<Entry> = [['', rootA]]
  let b: Array<Entry> = [['', rootB]]

  // Bring both frontiers to the same DEPTH before comparing anything. Two nodes only
  // share a hash when they sit at the same depth, so while one tree is taller its
  // frontier lines up against the wrong level of the other and nothing prunes. Walking
  // the leftmost spine costs one read per level, and dropping the taller side's extra
  // levels costs one read per node in a frontier that is still tiny near the root.
  let da = depthOf(rootA, store)
  let db = depthOf(rootB, store)

  while (da > db) {
    a = expandLevel(a, store)
    da--
  }
  while (db > da) {
    b = expandLevel(b, store)
    db--
  }

  const aligned = pruneShared(a, b)
  a = aligned.a
  b = aligned.b

  while (a.length > 0 || b.length > 0) {
    const na = a.map(e => loadNode(e[1], store))
    const nb = b.map(e => loadNode(e[1], store))

    // both sides are down to leaves: merge what is left and compare record hashes
    if (na.every(n => n.kind === 'L') && nb.every(n => n.kind === 'L')) {
      const ma = new Map<Mark, string>()
      const mb = new Map<Mark, string>()

      for (const node of na) {
        if (node.kind === 'L') {
          for (const [mark, rh] of node.entries) {
            ma.set(mark, rh)
          }
        }
      }
      for (const node of nb) {
        if (node.kind === 'L') {
          for (const [mark, rh] of node.entries) {
            mb.set(mark, rh)
          }
        }
      }

      for (const [mark, rh] of ma) {
        if (mb.get(mark) !== rh) {
          changed.add(mark) // edited, or removed if absent from B
        }
      }
      for (const [mark] of mb) {
        if (!ma.has(mark)) {
          changed.add(mark) // present only in B: added
        }
      }
      return
    }

    // expand one level. A branch is replaced by its children; a leaf waits here for the
    // other side to come down to its depth.
    const nextA: Array<Entry> = []
    const nextB: Array<Entry> = []

    a.forEach((entry, k) => {
      const node = na[k]!
      if (node.kind === 'B') {
        nextA.push(...node.children)
      } else {
        nextA.push(entry)
      }
    })
    b.forEach((entry, k) => {
      const node = nb[k]!
      if (node.kind === 'B') {
        nextB.push(...node.children)
      } else {
        nextB.push(entry)
      }
    })

    const pruned = pruneShared(nextA, nextB)
    a = pruned.a
    b = pruned.b
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
  if (rootA === rootB) {
    return changed // equal roots short-circuit: not a single chunk is read
  }
  diffFrontier(rootA, rootB, store, changed)
  return changed
}
