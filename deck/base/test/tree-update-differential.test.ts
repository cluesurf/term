// updateTree must agree with a full rebuild, on any edit.
//
// This is the invariant the whole store rests on and it has never been stated as a test.
// `updateTree` walks the parent tree, applies upserts and removes to a flat entry map, and
// writes the tree again. A future version that descends to the affected leaves and copies
// only the path back to the root (base-scale-0008) has to produce a BYTE-IDENTICAL tree, or
// two ways of writing the same records give different root hashes and history forks
// silently, with no error anywhere.
//
// Silently is the word that matters. A tree that is merely a different SHAPE holding the
// same records still reads back correctly, so every test that checks content passes, and
// only the hash disagrees. Content-addressed storage makes that a fork rather than a
// cosmetic difference.
//
// So the property is deliberately about the ROOT HASH and not about the records:
//
//   updateTree(root(base), upserts, removes)  ===  writeDataset(base + upserts - removes)
//
// Randomized, because the interesting cases are the ones nobody thinks to write. A prolly
// tree's node boundaries are content-defined: a group ends at an entry whose hash has a low
// bit pattern, or after sixteen entries, so an edit can shift where later groups begin, and
// whether that shift resynchronises is exactly what a hand-picked case will miss.
//
// Seeded, so a failure is reproducible. An unseeded random test that fails once and passes
// on rerun teaches people to rerun it.

import { describe, it, expect } from 'vitest'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { updateTree, writeDataset } from '@term/base/code/store/tree'
import type { Dataset } from '@term/base/code/diff/change'
import type { Mark, RecordNode } from '@term/base/code/base/type'

/** A small deterministic PRNG, so a failing case can be replayed from its seed. */
function random(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state * 1664525 + 1013904223) >>> 0

    return state / 0x100000000
  }
}

function markOf(n: number): Mark {
  const hex = n.toString(16).padStart(12, '0')

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(0, 3)}-8${hex.slice(3, 6)}-${hex.slice(0, 12)}`
}

function recordOf(n: number, salt: number): RecordNode {
  return {
    mark: markOf(n),
    type: 'word',
    fields: new Map([
      ['text', { kind: 'text', value: `word-${n}-${salt}` }],
      ['n', { kind: 'integer', value: BigInt(n) }],
    ]),
  }
}

/**
 * One random case: a base dataset, some upserts, some removes.
 *
 * Upserts deliberately mix NEW marks with edits to existing ones, because the two exercise
 * different paths: a new mark can split a group, and an edited one changes an entry's hash
 * in place, which can move a boundary without changing how many entries there are.
 */
function caseOf(seed: number): {
  base: Dataset
  upserts: Map<Mark, RecordNode>
  removes: Set<Mark>
} {
  const next = random(seed)
  const size = 1 + Math.floor(next() * 400)
  const base: Dataset = new Map()

  for (let n = 0; n < size; n++) {
    base.set(markOf(n), recordOf(n, 0))
  }

  const upserts = new Map<Mark, RecordNode>()
  const removes = new Set<Mark>()
  const edits = Math.floor(next() * 40)

  for (let i = 0; i < edits; i++) {
    const roll = next()
    const n = Math.floor(next() * (size + 40))

    if (roll < 0.45) {
      // a brand new mark, possibly past the end of the base range
      upserts.set(markOf(n), recordOf(n, 1))
    } else if (roll < 0.8) {
      // an edit to an existing mark, which changes its entry hash in place
      if (base.has(markOf(n))) {
        upserts.set(markOf(n), recordOf(n, 2))
      }
    } else if (base.has(markOf(n))) {
      removes.add(markOf(n))
    }
  }

  // An upsert wins over a remove of the same mark, which is what applying them in that
  // order means, so the expected dataset below cannot be ambiguous.
  for (const mark of upserts.keys()) {
    removes.delete(mark)
  }

  return { base, upserts, removes }
}

function expected(
  base: Dataset,
  upserts: Map<Mark, RecordNode>,
  removes: Set<Mark>,
): Dataset {
  const out: Dataset = new Map(base)

  for (const [mark, record] of upserts) {
    out.set(mark, record)
  }

  for (const mark of removes) {
    out.delete(mark)
  }

  return out
}

/** The two roots for one case: incremental, and rebuilt from scratch. */
function roots(seed: number): { incremental: string; rebuilt: string; size: number } {
  const { base, upserts, removes } = caseOf(seed)

  // Separate stores, so neither run can accidentally read a chunk the other wrote and
  // agree for the wrong reason.
  const one = new MemoryChunkStore()
  const two = new MemoryChunkStore()

  const parent = writeDataset(base, one)
  const incremental = updateTree(parent, upserts, removes, one)
  const rebuilt = writeDataset(expected(base, upserts, removes), two)

  return { incremental, rebuilt, size: base.size }
}

describe('updateTree agrees with a full rebuild', () => {
  it('on 300 random edit sequences', () => {
    // The gate for base-scale-0008. A future incremental implementation runs this unchanged,
    // and a resync bug shows up as a differing root rather than as nothing at all.
    const failed: number[] = []

    for (let seed = 1; seed <= 300; seed++) {
      const { incremental, rebuilt } = roots(seed)

      if (incremental !== rebuilt) {
        failed.push(seed)
      }
    }

    expect(failed).toEqual([])
  })

  it('when every record is replaced', () => {
    // The whole tree changes, so nothing can be reused and every boundary is recomputed.
    const base: Dataset = new Map()
    const upserts = new Map<Mark, RecordNode>()

    for (let n = 0; n < 200; n++) {
      base.set(markOf(n), recordOf(n, 0))
      upserts.set(markOf(n), recordOf(n, 9))
    }

    const one = new MemoryChunkStore()
    const two = new MemoryChunkStore()

    expect(updateTree(writeDataset(base, one), upserts, new Set(), one)).toBe(
      writeDataset(expected(base, upserts, new Set()), two),
    )
  })

  it('when every record is removed, leaving an empty tree', () => {
    // The edge a rebuild handles with its own branch. An incremental version has to reach
    // the same empty-tree root rather than an empty leaf under an old parent.
    const base: Dataset = new Map()
    const removes = new Set<Mark>()

    for (let n = 0; n < 120; n++) {
      base.set(markOf(n), recordOf(n, 0))
      removes.add(markOf(n))
    }

    const one = new MemoryChunkStore()
    const two = new MemoryChunkStore()

    expect(updateTree(writeDataset(base, one), new Map(), removes, one)).toBe(
      writeDataset(new Map(), two),
    )
  })

  it('when nothing changes at all', () => {
    // An empty edit must reproduce the parent root exactly. Anything else means a no-op
    // commit writes a new tree, and every retry would look like a change.
    const base: Dataset = new Map()

    for (let n = 0; n < 150; n++) {
      base.set(markOf(n), recordOf(n, 0))
    }

    const store = new MemoryChunkStore()
    const parent = writeDataset(base, store)

    expect(updateTree(parent, new Map(), new Set(), store)).toBe(parent)
  })

  it('on a tree of one record, and on the empty tree', () => {
    const store = new MemoryChunkStore()
    const other = new MemoryChunkStore()

    const one: Dataset = new Map([[markOf(0), recordOf(0, 0)]])
    const parent = writeDataset(one, store)

    expect(
      updateTree(parent, new Map([[markOf(1), recordOf(1, 0)]]), new Set(), store),
    ).toBe(
      writeDataset(
        new Map([
          [markOf(0), recordOf(0, 0)],
          [markOf(1), recordOf(1, 0)],
        ]),
        other,
      ),
    )

    const empty = new MemoryChunkStore()
    const fresh = new MemoryChunkStore()
    const emptyRoot = writeDataset(new Map(), empty)

    expect(
      updateTree(emptyRoot, new Map([[markOf(0), recordOf(0, 0)]]), new Set(), empty),
    ).toBe(writeDataset(new Map([[markOf(0), recordOf(0, 0)]]), fresh))
  })

  it('removing a mark the tree never held changes nothing', () => {
    const base: Dataset = new Map()

    for (let n = 0; n < 90; n++) {
      base.set(markOf(n), recordOf(n, 0))
    }

    const store = new MemoryChunkStore()
    const parent = writeDataset(base, store)

    expect(
      updateTree(parent, new Map(), new Set([markOf(9999)]), store),
    ).toBe(parent)
  })
})
