import { describe, it, expect } from 'vitest'
import { record, text } from '@/base/make'
import type { RecordNode } from '@/base/type'
import { datasetOf, type Dataset } from '@/diff/change'
import { canonicalizeRecord } from '@/canon/canonicalize'
import { mergeDataset } from '@/merge/merge'

// The three-way merge should behave like a join over a common base: merging is
// idempotent, commutative in its two sides, and (for independent edits) associative,
// with the base acting as a unit. These are the join-semilattice laws the merge design
// commits to. See note/library/base/design/merge-formal-spec.md.

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

// A canonical, order-independent fingerprint of a dataset, for equality assertions.
function fingerprint(ds: Dataset): string {
  return [...ds.keys()]
    .sort()
    .map(m => `${m}=${canonicalizeRecord(ds.get(m)!)}`)
    .join('\n')
}

function base(n: number): Array<RecordNode> {
  const out: Array<RecordNode> = []
  for (let i = 0; i < n; i++) {
    out.push(
      record({
        type: 'word',
        mark: markOf(i),
        fields: { term: text(`w${i}`), gloss: text(`g${i}`), note: text(`n${i}`) },
      }),
    )
  }
  return out
}

// Edit one field of a subset of records to distinct new values, leaving the rest as-is.
function editField(
  records: Array<RecordNode>,
  field: string,
  which: (i: number) => boolean,
  tag: string,
): Dataset {
  return datasetOf(
    records.map((r, i) => {
      if (!which(i)) {
        return r
      }
      const fields = new Map(r.fields)
      fields.set(field, text(`${tag}${i}`))
      return { ...r, fields }
    }),
  )
}

describe('merge semilattice laws', () => {
  for (const n of [1, 4, 12, 40]) {
    const b = base(n)
    const baseDs = datasetOf(b)

    it(`is idempotent: merge(base, a, a) == a  (n=${n})`, () => {
      const a = editField(b, 'term', i => i % 2 === 0, 'A')
      const { merged, conflicts } = mergeDataset(baseDs, a, a)
      expect(conflicts).toEqual([])
      expect(fingerprint(merged)).toBe(fingerprint(a))
    })

    it(`has the base as a unit: merge(base, base, b) == b  (n=${n})`, () => {
      const other = editField(b, 'gloss', i => i % 3 === 0, 'B')
      const left = mergeDataset(baseDs, baseDs, other)
      expect(left.conflicts).toEqual([])
      expect(fingerprint(left.merged)).toBe(fingerprint(other))
    })

    it(`is commutative: merge(base, a, b) == merge(base, b, a)  (n=${n})`, () => {
      // a and b edit disjoint fields, so there are no conflicts
      const a = editField(b, 'term', i => i % 2 === 0, 'A')
      const bEdit = editField(b, 'note', i => i % 2 === 1, 'B')
      const ab = mergeDataset(baseDs, a, bEdit)
      const ba = mergeDataset(baseDs, bEdit, a)
      expect(ab.conflicts).toEqual([])
      expect(ba.conflicts).toEqual([])
      expect(fingerprint(ab.merged)).toBe(fingerprint(ba.merged))
    })

    it(`is associative for independent edits  (n=${n})`, () => {
      // three branches editing three disjoint fields: any grouping converges
      const a = editField(b, 'term', i => i % 3 === 0, 'A')
      const bb = editField(b, 'gloss', i => i % 3 === 1, 'B')
      const c = editField(b, 'note', i => i % 3 === 2, 'C')

      const ab = mergeDataset(baseDs, a, bb)
      expect(ab.conflicts).toEqual([])
      const left = mergeDataset(baseDs, ab.merged, c)

      const bc = mergeDataset(baseDs, bb, c)
      expect(bc.conflicts).toEqual([])
      const right = mergeDataset(baseDs, a, bc.merged)

      expect(left.conflicts).toEqual([])
      expect(right.conflicts).toEqual([])
      expect(fingerprint(left.merged)).toBe(fingerprint(right.merged))
    })
  }

  it('surfaces a genuine same-field conflict symmetrically', () => {
    const b = base(3)
    const baseDs = datasetOf(b)
    const a = editField(b, 'term', i => i === 0, 'A')
    const bEdit = editField(b, 'term', i => i === 0, 'B')
    const ab = mergeDataset(baseDs, a, bEdit)
    const ba = mergeDataset(baseDs, bEdit, a)
    // both orders see exactly one conflict at the same place
    expect(ab.conflicts.length).toBe(1)
    expect(ba.conflicts.length).toBe(1)
    expect(ab.conflicts[0]!.mark).toBe(ba.conflicts[0]!.mark)
    expect(ab.conflicts[0]!.path).toBe(ba.conflicts[0]!.path)
  })
})
