import { describe, it, expect } from 'vitest'
import {
  record,
  text,
  integer,
  decimal,
  boolean,
  date,
  nul,
  ref,
  blob,
  list,
  set,
  log,
  nested,
  item,
} from '@term/base/code/base/make'
import type { RecordNode } from '@term/base/code/base/type'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { decodeRecord } from '@term/base/code/canon/decode'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { writeDataset, readDataset, diffRoots } from '@term/base/code/store/tree'

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

function bigDataset(n: number): Dataset {
  const records: Array<RecordNode> = []
  for (let i = 0; i < n; i++) {
    records.push(
      record({
        type: 'word',
        mark: markOf(i),
        fields: { term: text(`w${i}`), count: integer(i) },
      }),
    )
  }
  return datasetOf(records)
}

describe('canonical decode round-trip', () => {
  it('reverses every value kind', () => {
    const r = record({
      type: 'word',
      mark: markOf(1),
      label: 'hi',
      fields: {
        a: text('x'),
        b: integer(42),
        c: decimal('1.20'),
        d: boolean(true),
        e: date('2026-07-16'),
        f: nul(),
        g: ref(markOf(2)),
        h: blob('sha256:abc'),
        i: list([item(text('a')), item(text('b'))]),
        j: set([item(text('q'), markOf(3))]),
        k: log([item(text('src'))]),
        l: nested(record({ type: 'sense', mark: markOf(4), fields: { g: text('gg') } })),
      },
    })
    const bytes = canonicalizeRecord(r)
    const back = decodeRecord(bytes)
    expect(canonicalizeRecord(back)).toBe(bytes)
  })
})

describe('prolly-tree store', () => {
  it('round-trips a dataset through the store', () => {
    const store = new MemoryChunkStore()
    const ds = bigDataset(40)
    const root = writeDataset(ds, store)
    const back = readDataset(root, store)
    expect(back.size).toBe(ds.size)
    for (const mark of ds.keys()) {
      expect(canonicalizeRecord(back.get(mark)!)).toBe(
        canonicalizeRecord(ds.get(mark)!),
      )
    }
  })

  it('is deterministic: same data, same root', () => {
    const s1 = new MemoryChunkStore()
    const s2 = new MemoryChunkStore()
    expect(writeDataset(bigDataset(30), s1)).toBe(
      writeDataset(bigDataset(30), s2),
    )
  })

  it('dedups unchanged records and shares chunks across versions', () => {
    const store = new MemoryChunkStore()
    const ds = bigDataset(40)
    writeDataset(ds, store)
    const sizeAfterFirst = store.size()
    // change one record, rewrite: only a few new chunks (the record, its leaf, and
    // the branch path to the root), not another 40+ chunks
    const ds2 = new Map(ds)
    ds2.set(
      markOf(5),
      record({
        type: 'word',
        mark: markOf(5),
        fields: { term: text('changed'), count: integer(5) },
      }),
    )
    writeDataset(ds2, store)
    const added = store.size() - sizeAfterFirst
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThan(10)
  })

  it('diffs two roots by pruning shared subtrees, returning only changed marks', () => {
    const store = new MemoryChunkStore()
    const ds = bigDataset(50)
    const rootA = writeDataset(ds, store)

    const ds2 = new Map(ds)
    // modify one, add one, remove one
    ds2.set(
      markOf(7),
      record({ type: 'word', mark: markOf(7), fields: { term: text('mod') } }),
    )
    ds2.set(
      markOf(999),
      record({ type: 'word', mark: markOf(999), fields: { term: text('new') } }),
    )
    ds2.delete(markOf(3))
    const rootB = writeDataset(ds2, store)

    const changed = diffRoots(rootA, rootB, store)
    expect(changed).toEqual(new Set([markOf(7), markOf(999), markOf(3)]))
  })

  it('reports no diff between identical roots', () => {
    const store = new MemoryChunkStore()
    const root = writeDataset(bigDataset(20), store)
    expect(diffRoots(root, root, store).size).toBe(0)
  })
})

// A store whose every chunk hash ends in a content-defined boundary byte, which
// makes `chunk` produce all-singleton groups so a tree level never shrinks. Before
// the no-progress guard in writeTree, this wedged the build in an infinite loop.
class BoundaryStore {
  private map = new Map<string, string>()
  private byBytes = new Map<string, string>()
  private n = 0
  put(bytes: string): string {
    const existing = this.byBytes.get(bytes)
    if (existing !== undefined) {
      return existing
    }
    // 40 hex chars ending in "00": (0x00 & 0x3) === 0, so isBoundary is always true
    const hash = (this.n++).toString(16).padStart(38, '0') + '00'
    this.map.set(hash, bytes)
    this.byBytes.set(bytes, hash)
    return hash
  }
  get(hash: string): string | undefined {
    return this.map.get(hash)
  }
  has(hash: string): boolean {
    return this.map.has(hash)
  }
  size(): number {
    return this.map.size
  }
}

describe('writeTree termination', () => {
  it('terminates and round-trips when every entry is a chunk boundary', () => {
    const store = new BoundaryStore()
    const records: Array<RecordNode> = []
    for (let i = 0; i < 12; i++) {
      records.push(
        record({ type: 'word', mark: markOf(i), fields: { n: integer(BigInt(i)) } }),
      )
    }
    const dataset = datasetOf(records)

    // would hang forever before the fix
    const root = writeDataset(dataset, store)
    const back = readDataset(root, store)

    expect(back.size).toBe(dataset.size)
    for (const [mark, r] of dataset) {
      expect(canonicalizeRecord(back.get(mark)!)).toBe(canonicalizeRecord(r))
    }
  })
})
