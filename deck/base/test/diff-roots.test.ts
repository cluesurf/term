import { describe, it, expect } from 'vitest'
import { record, text } from '@/base/make'
import type { RecordNode } from '@/base/type'
import { datasetOf } from '@/diff/change'
import { MemoryChunkStore } from '@/store/chunk-store'
import type { ChunkStore } from '@/store/chunk-store'
import { writeDataset, updateTree, diffRoots } from '@/store/tree'

// A chunk store that counts reads, to prove the diff walks only the changed region.
class CountingStore implements ChunkStore {
  gets = 0
  constructor(private inner = new MemoryChunkStore()) {}
  put(bytes: string): string {
    return this.inner.put(bytes)
  }
  get(hash: string): string | undefined {
    this.gets++
    return this.inner.get(hash)
  }
  has(hash: string): boolean {
    return this.inner.has(hash)
  }
  size(): number {
    return this.inner.size()
  }
}

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

function bigDataset(n: number): Array<RecordNode> {
  const out: Array<RecordNode> = []
  for (let i = 0; i < n; i++) {
    out.push(record({ type: 'word', mark: markOf(i), fields: { term: text(`w${i}`) } }))
  }
  return out
}

describe('diffRoots (cursor diff)', () => {
  it('returns nothing for identical roots without reading a chunk', () => {
    const store = new CountingStore()
    const root = writeDataset(datasetOf(bigDataset(200)), store)
    store.gets = 0
    expect(diffRoots(root, root, store).size).toBe(0)
    expect(store.gets).toBe(0) // equal hash short-circuits, no read at all
  })

  // KNOWN FAILING, AND THE ASSERTION IS RIGHT. Measured July 27, 2026: reads
  // scale LINEARLY with the dataset (154 at 200 records, 1166 at 1600) and sit
  // near half the total chunks, where a pruning prolly-tree diff should be
  // O(log n) and roughly flat. 14-storage-substrate.md justifies the substrate
  // on the opposite claim, that a diff costs the size of the change.
  //
  // Do NOT relax this threshold to make the suite green. The number is correct
  // and the behaviour is wrong. Correctness is unaffected: the diff still
  // reports exactly the changed record, which the assertion below still proves.
  //
  // Investigation and the leading hypothesis (updateTree rebuilding beyond the
  // spine, leaving no shared subtrees to prune against) are in
  // note/library/base/hardening-roadmap.md, Phase 6.
  it('detects a single edit and reads only the path to it', () => {
    const store = new CountingStore()
    const rootA = writeDataset(datasetOf(bigDataset(200)), store)
    const rootB = updateTree(
      rootA,
      new Map([[markOf(100), record({ type: 'word', mark: markOf(100), fields: { term: text('EDIT') } })]]),
      new Set(),
      store,
    )
    store.gets = 0
    const changed = diffRoots(rootA, rootB, store)
    expect([...changed]).toEqual([markOf(100)])
    // walking only the changed path reads far fewer nodes than the ~200-leaf tree
    expect(store.gets).toBeLessThan(40)
  })

  it('detects an added record', () => {
    const store = new MemoryChunkStore()
    const rootA = writeDataset(datasetOf(bigDataset(50)), store)
    const rootB = updateTree(
      rootA,
      new Map([[markOf(999), record({ type: 'word', mark: markOf(999), fields: { term: text('new') } })]]),
      new Set(),
      store,
    )
    expect([...diffRoots(rootA, rootB, store)]).toEqual([markOf(999)])
  })

  it('detects a removed record', () => {
    const store = new MemoryChunkStore()
    const rootA = writeDataset(datasetOf(bigDataset(50)), store)
    const rootB = updateTree(rootA, new Map(), new Set([markOf(25)]), store)
    expect([...diffRoots(rootA, rootB, store)]).toEqual([markOf(25)])
  })

  it('detects several scattered edits at once', () => {
    const store = new MemoryChunkStore()
    const rootA = writeDataset(datasetOf(bigDataset(300)), store)
    const upserts = new Map<string, RecordNode>()
    for (const i of [7, 88, 150, 299]) {
      upserts.set(markOf(i), record({ type: 'word', mark: markOf(i), fields: { term: text(`x${i}`) } }))
    }
    const rootB = updateTree(rootA, upserts, new Set(), store)
    expect([...diffRoots(rootA, rootB, store)].sort()).toEqual(
      [7, 88, 150, 299].map(markOf).sort(),
    )
  })

  it('agrees with a full scan on a mixed change set', () => {
    const store = new MemoryChunkStore()
    const a = bigDataset(120)
    const rootA = writeDataset(datasetOf(a), store)
    const upserts = new Map<string, RecordNode>([
      [markOf(3), record({ type: 'word', mark: markOf(3), fields: { term: text('e3') } })],
      [markOf(500), record({ type: 'word', mark: markOf(500), fields: { term: text('add') } })],
    ])
    const removes = new Set([markOf(60), markOf(61)])
    const rootB = updateTree(rootA, upserts, removes, store)

    // brute-force expectation
    const expected = new Set([markOf(3), markOf(500), markOf(60), markOf(61)])
    expect(new Set(diffRoots(rootA, rootB, store))).toEqual(expected)
  })
})
