import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import type { Op } from '@term/base/code/sync/op-sync'
import type { Hlc } from '@term/base/code/merge/clock'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'

const GUIDE = '11111111-1111-4111-8111-111111111111'
const meta = (t: number, m: string) => ({ author: 'ada', time: t, message: m })
const hlc = (wall: number, node = 'ada'): Hlc => ({ wall, count: 0, node })

function setField(mark: string, field: string, before: string | undefined, after: string, wall: number): Op {
  return {
    hlc: hlc(wall),
    change: {
      type: 'field.set',
      mark,
      field,
      before: before === undefined ? undefined : text(before),
      after: text(after),
    },
  }
}

function makeRepo() {
  const chunks = new MemoryChunkStore()
  const repo = new Repository(chunks, new MemoryRefStore())
  const first = repo.commit(
    'main',
    meta(1, 'init'),
    datasetOf([record({ type: 'guide', mark: GUIDE, fields: { body: text('draft one') } })]),
  )
  if (!first.ok) throw new Error('init failed')
  return { chunks, repo, head0: first.commit }
}

describe('live-draft repository integration', () => {
  it('realtime edits are visible in the draft without a commit, then publish makes one', () => {
    const { repo, head0 } = makeRepo()

    // an editor types: five keystrokes into the body, coalesced client-side into ops
    repo.appendDraft('main', [
      setField(GUIDE, 'body', 'draft one', 'draft one edited', 10),
    ])

    // the draft shows the edit immediately...
    expect(repo.draftDataset('main').get(GUIDE)!.fields.get('body')).toEqual(
      text('draft one edited'),
    )
    // ...but the committed head has NOT moved and no commit was made
    expect(repo.head('main')).toBe(head0)
    expect(repo.checkoutBranch('main').get(GUIDE)!.fields.get('body')).toEqual(
      text('draft one'),
    )
    expect(repo.draftPending('main')).toBeDefined()

    // publish: one commit for the whole burst, head advances, draft clears
    const published = repo.publishDraft('main', meta(2, 'publish'))
    expect(published.ok).toBe(true)
    expect(repo.head('main')).not.toBe(head0)
    expect(repo.checkoutBranch('main').get(GUIDE)!.fields.get('body')).toEqual(
      text('draft one edited'),
    )
    expect(repo.draftPending('main')).toBeUndefined()
    // exactly one new commit landed
    expect(repo.log('main').length).toBe(2)
  })

  it('multiple appends across segments fold into one published commit', () => {
    const { repo } = makeRepo()

    repo.appendDraft('main', [setField(GUIDE, 'title', undefined, 'A', 10)])
    repo.appendDraft('main', [setField(GUIDE, 'title', 'A', 'AB', 20)])
    repo.appendDraft('main', [setField(GUIDE, 'body', 'draft one', 'body two', 30)])

    const draft = repo.draftDataset('main').get(GUIDE)!
    expect(draft.fields.get('title')).toEqual(text('AB'))
    expect(draft.fields.get('body')).toEqual(text('body two'))

    const before = repo.log('main').length
    repo.publishDraft('main', meta(2, 'publish'))
    expect(repo.log('main').length).toBe(before + 1) // one commit, not three
    expect(repo.draftPending('main')).toBeUndefined()
  })

  it('gc keeps an in-flight draft alive, and reclaims a discarded one', () => {
    const { repo } = makeRepo()
    repo.appendDraft('main', [setField(GUIDE, 'body', 'draft one', 'wip', 10)])
    const pending = repo.draftPending('main')!

    // a garbage collection while the draft is open must not sweep its segment
    repo.gc()
    expect(repo.draftDataset('main').get(GUIDE)!.fields.get('body')).toEqual(text('wip'))

    // discard drops the pointer; gc then reclaims the now-unreachable segment
    repo.discardDraft('main')
    const report = repo.gc()
    expect(report.removedHashes).toContain(pending)
    // the draft is gone, the committed state is intact
    expect(repo.draftPending('main')).toBeUndefined()
    expect(repo.checkoutBranch('main').get(GUIDE)!.fields.get('body')).toEqual(text('draft one'))
  })

  it('publish is a no-op success when nothing is pending', () => {
    const { repo, head0 } = makeRepo()
    const r = repo.publishDraft('main', meta(2, 'noop'))
    expect(r.ok).toBe(true)
    expect(repo.head('main')).toBe(head0)
  })
})
