// Does the prolly-tree diff cost the size of the CHANGE, or the size of the DATASET?
//
// The whole storage argument rests on the first answer. `14-storage-substrate.md` sells the
// prolly tree on exactly this: "diffing two versions compares two Merkle roots and skips
// every subtree whose hash matches, so a diff costs the number of differences, not the number
// of records. This is what makes commits, blame, and history cheap at scale."
//
// `hardening-roadmap.md` Phase 6 then recorded the opposite as a CONFIRMED defect, with a test
// deliberately left failing. By the time this folder was audited there was no failing test,
// and nothing said whether the defect had been fixed or the test removed.
//
// That is a worse state than a known defect. A known defect stays planned around; a claim
// that used to be measured and is now neither measured nor disproved gets quietly assumed
// away, and every estimate built on top of it inherits the assumption.
//
// So: measure it. Build the same tree at three sizes, change ONE record, and count the chunks
// the diff reads. If the count is roughly flat as the dataset grows tenfold, the diff costs
// the change. If it grows with the dataset, the defect is live and the storage argument is
// not true as written.

import { describe, it, expect } from 'vitest'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import type { ChunkStore } from '@term/base/code/store/chunk-store'
import { writeDataset, diffRoots } from '@term/base/code/store/tree'
import { record, text } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'

/** A store that counts reads, so the cost of a diff is observable rather than inferred. */
class CountingStore implements ChunkStore {
  reads = 0

  constructor(private readonly inner: MemoryChunkStore) {}

  put(bytes: string): string {
    return this.inner.put(bytes)
  }

  get(hash: string): string | undefined {
    this.reads += 1

    return this.inner.get(hash)
  }

  has(hash: string): boolean {
    return this.inner.has(hash)
  }

  size(): number {
    return this.inner.size()
  }
}

function mark(i: number): string {
  // a valid uuid whose last twelve digits carry the index, so marks spread across the tree
  // rather than clustering, which is what a real corpus does
  return `0195f0e6-1c4a-7bd3-9f2e-${String(i).padStart(12, '0')}`
}

function corpus(size: number, changed?: number): Dataset {
  const records = []

  for (let i = 0; i < size; i += 1) {
    records.push(
      record({
        type: 'word',
        mark: mark(i),
        fields: {
          text: text(i === changed ? `word-${i}-EDITED` : `word-${i}`),
        },
      }),
    )
  }

  return datasetOf(records)
}

/** Chunks read while diffing a dataset against itself with one record changed. */
function readsForOneChange(size: number): number {
  const inner = new MemoryChunkStore()
  const before = writeDataset(corpus(size), inner)
  // change the record in the MIDDLE, so the walk cannot get lucky at an edge
  const after = writeDataset(corpus(size, Math.floor(size / 2)), inner)

  const counting = new CountingStore(inner)
  const changed = diffRoots(before, after, counting)

  expect(changed.size).toBe(1)

  return counting.reads
}

describe('the cost of a diff', () => {
  it('reads nothing at all when the roots are equal', () => {
    const inner = new MemoryChunkStore()
    const root = writeDataset(corpus(500), inner)
    const counting = new CountingStore(inner)

    expect(diffRoots(root, root, counting).size).toBe(0)
    // the short-circuit the storage doc promises: not one chunk
    expect(counting.reads).toBe(0)
  })

  it('finds exactly the one record that changed, at every size', () => {
    for (const size of [100, 1000]) {
      const inner = new MemoryChunkStore()
      const before = writeDataset(corpus(size), inner)
      const after = writeDataset(corpus(size, Math.floor(size / 2)), inner)
      const changed = diffRoots(before, after, inner)

      expect([...changed]).toEqual([mark(Math.floor(size / 2))])
    }
  })

  it('costs the size of the CHANGE, not the size of the dataset', () => {
    // The measurement this file exists for. A tenfold dataset must not cost tenfold reads.
    const small = readsForOneChange(100)
    const medium = readsForOneChange(1_000)
    const large = readsForOneChange(10_000)

    // Reported so a failure shows the shape rather than only that a threshold was crossed.
    // eslint-disable-next-line no-console
    console.log(
      `one-record diff, chunk reads: 100 -> ${small}, 1000 -> ${medium}, 10000 -> ${large}`,
    )

    // Growth is allowed to be logarithmic, because the tree gets DEEPER as it grows and the
    // walk descends one frontier per level. What is forbidden is growth with the dataset.
    // A hundredfold dataset costing under eightfold reads rules that out with room to spare,
    // while still failing loudly if pruning stops working: an unpruned walk would read every
    // chunk, which at 10,000 records is hundreds of times the small case.
    expect(large).toBeLessThan(small * 8)

    // and each step is bounded the same way, so a single bad level is caught too
    expect(medium).toBeLessThan(small * 4)
    expect(large).toBeLessThan(medium * 4)
  })

  it('costs about the same for one change wherever it lands', () => {
    // if the cost depended on WHERE the change is, the walk would be scanning rather than
    // descending, which is the same defect wearing a different hat
    const size = 2_000
    const at = (index: number): number => {
      const inner = new MemoryChunkStore()
      const before = writeDataset(corpus(size), inner)
      const after = writeDataset(corpus(size, index), inner)
      const counting = new CountingStore(inner)
      diffRoots(before, after, counting)

      return counting.reads
    }

    const first = at(0)
    const middle = at(size / 2)
    const last = at(size - 1)
    const most = Math.max(first, middle, last)
    const least = Math.min(first, middle, last)

    expect(most).toBeLessThan(least * 3)
  })
})
