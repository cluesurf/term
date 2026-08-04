import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@term/base/code/base/make'
import type { RecordNode } from '@term/base/code/base/type'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { writeDataset, readRecord } from '@term/base/code/store/tree'
import { catchUp } from '@term/base/code/store/mirror'

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}

function bigDataset(n: number): Dataset {
  const records: Array<RecordNode> = []
  for (let i = 0; i < n; i++) {
    records.push(record({ type: 'word', mark: markOf(i), fields: { term: text(`w${i}`) } }))
  }
  return datasetOf(records)
}

describe('point lookup', () => {
  it('reads one record by mark without materializing the tree', () => {
    const store = new MemoryChunkStore()
    const root = writeDataset(bigDataset(60), store)
    const r = readRecord(root, markOf(37), store)
    expect(r!.fields.get('term')).toEqual(text('w37'))
    expect(readRecord(root, markOf(9999), store)).toBeUndefined()
  })
})

describe('mirror catch-up', () => {
  it('catches up by fetching only the changed records', () => {
    const store = new MemoryChunkStore()
    const ds = bigDataset(80)
    const snapshot = writeDataset(ds, store)

    // many commits worth of changes accumulate into a new root
    const ds2 = new Map(ds)
    ds2.set(markOf(10), record({ type: 'word', mark: markOf(10), fields: { term: text('changed') } }))
    ds2.set(markOf(500), record({ type: 'word', mark: markOf(500), fields: { term: text('new'), n: integer(1) } }))
    ds2.delete(markOf(20))
    const target = writeDataset(ds2, store)

    const cu = catchUp(snapshot, target, store)
    const upsertMarks = cu.upsert.map(r => r.mark).sort()
    expect(upsertMarks).toEqual([markOf(10), markOf(500)].sort())
    expect(cu.remove).toEqual([markOf(20)])
  })

  it('is a no-op when already current', () => {
    const store = new MemoryChunkStore()
    const root = writeDataset(bigDataset(30), store)
    const cu = catchUp(root, root, store)
    expect(cu.upsert).toEqual([])
    expect(cu.remove).toEqual([])
  })
})
