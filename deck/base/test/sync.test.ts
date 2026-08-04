import { describe, it, expect } from 'vitest'
import { record, text } from '@/base/make'
import type { RecordNode } from '@/base/type'
import { datasetOf, type Change, type Dataset } from '@/diff/change'
import { MemoryChunkStore } from '@/store/chunk-store'
import { writeDataset, readDataset } from '@/store/tree'
import { pull, packMissing, applyChunks } from '@/sync/chunk-sync'
import { OpLog, applyOps } from '@/sync/op-sync'
import { emptyDataset } from '@/diff/change'
import type { Hlc } from '@/merge/clock'

function markOf(i: number): string {
  return `${i.toString(16).padStart(8, '0')}-0000-4000-8000-000000000000`
}
function bigDataset(n: number): Dataset {
  const rs: Array<RecordNode> = []
  for (let i = 0; i < n; i++) {
    rs.push(record({ type: 'word', mark: markOf(i), fields: { term: text(`w${i}`) } }))
  }
  return datasetOf(rs)
}

describe('chunk sync (async replica)', () => {
  it('transfers a full state to an empty peer', () => {
    const source = new MemoryChunkStore()
    const target = new MemoryChunkStore()
    const ds = bigDataset(40)
    const root = writeDataset(ds, source)
    pull(root, source, target)
    const back = readDataset(root, target)
    expect(back.size).toBe(40)
  })

  it('transfers only missing chunks when catching up', () => {
    const source = new MemoryChunkStore()
    const target = new MemoryChunkStore()
    const ds = bigDataset(50)
    const root1 = writeDataset(ds, source)
    pull(root1, source, target)

    // source advances by one record
    const ds2 = new Map(ds)
    ds2.set(markOf(5), record({ type: 'word', mark: markOf(5), fields: { term: text('changed') } }))
    const root2 = writeDataset(ds2, source)

    const chunks = packMissing(root2, source, h => target.has(h))
    // only the changed record, its leaf, and the branch path to the root
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks.length).toBeLessThan(10)
    applyChunks(chunks, target)
    expect(readDataset(root2, target).get(markOf(5))!.fields.get('term')).toEqual(
      text('changed'),
    )
  })

  it('rejects a corrupted chunk', () => {
    const target = new MemoryChunkStore()
    expect(() =>
      applyChunks([{ hash: 'sha256:deadbeef', bytes: 'tampered' }], target),
    ).toThrow(/integrity/)
  })
})

describe('op delta sync (realtime)', () => {
  it('replays only operations since a peer clock', () => {
    const log = new OpLog()
    const hlc = (wall: number): Hlc => ({ wall, count: 0, node: 'n' })
    const add = (i: number): Change => ({
      type: 'record.add',
      mark: markOf(i),
      value: record({ type: 'word', mark: markOf(i), fields: { term: text(`w${i}`) } }),
    })
    log.append({ hlc: hlc(1), change: add(1) })
    log.append({ hlc: hlc(2), change: add(2) })
    log.append({ hlc: hlc(3), change: add(3) })

    const delta = log.since(hlc(1))
    expect(delta.length).toBe(2)

    const caughtUp = applyOps(emptyDataset(), log.all())
    expect(caughtUp.size).toBe(3)
  })
})
