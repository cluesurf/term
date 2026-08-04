import { describe, it, expect } from 'vitest'
import { record, text } from '@term/base/code/base/make'
import type { Change } from '@term/base/code/diff/change'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { autoMark } from '@term/base/code/form/automark'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryProjection } from '@term/base/code/project/projection'
import { sync, ChangeFeed } from '@term/base/code/project/feed'

const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const meta = (message: string) => ({ author: 'a', time: 1, message })

function repo(): Repository {
  return new Repository(new MemoryChunkStore(), new MemoryRefStore())
}

describe('projection', () => {
  it('projects a branch head and queries it', () => {
    const r = repo()
    r.commit(
      'main',
      meta('c1'),
      datasetOf([
        record({ type: 'word', mark: M1, fields: { term: text('foo'), lang: text('en') } }),
        record({ type: 'word', mark: M2, fields: { term: text('bar'), lang: text('bo') } }),
      ]),
    )
    const proj = new MemoryProjection()
    sync(r, 'main', proj)
    expect(proj.size()).toBe(2)
    expect(proj.servingCommit()).toBe(r.head('main'))
    expect(proj.where('word', 'lang', text('en')).map(x => x.mark)).toEqual([M1])
  })

  it('advances incrementally as the branch moves', () => {
    const r = repo()
    r.commit('main', meta('c1'), datasetOf([record({ type: 'word', mark: M1, fields: { term: text('a') } })]))
    const proj = new MemoryProjection()
    sync(r, 'main', proj)
    expect(proj.size()).toBe(1)

    r.commit(
      'main',
      meta('c2'),
      datasetOf([
        record({ type: 'word', mark: M1, fields: { term: text('A') } }),
        record({ type: 'word', mark: M2, fields: { term: text('b') } }),
      ]),
    )
    sync(r, 'main', proj)
    expect(proj.size()).toBe(2)
    expect(proj.get(M1)!.fields.get('term')).toEqual(text('A'))
    expect(proj.servingCommit()).toBe(r.head('main'))
  })

  it('feeds a custom projection through the change feed', () => {
    const feed = new ChangeFeed()
    // a custom in-memory index: terms by first letter (like clue.surf/find)
    const byFirstLetter = new Map<string, Set<string>>()
    feed.subscribe((changes: Array<Change>) => {
      for (const ch of changes) {
        if (ch.type === 'record.add') {
          const term = ch.value.fields.get('term')
          if (term && term.kind === 'text') {
            const key = term.value[0] ?? ''
            const set = byFirstLetter.get(key) ?? new Set<string>()
            set.add(ch.mark)
            byFirstLetter.set(key, set)
          }
        }
      }
    })
    feed.emit([
      { type: 'record.add', mark: M1, value: record({ type: 'word', mark: M1, fields: { term: text('apple') } }) },
      { type: 'record.add', mark: M2, value: record({ type: 'word', mark: M2, fields: { term: text('avocado') } }) },
    ])
    expect(byFirstLetter.get('a')).toEqual(new Set([M1, M2]))
  })
})

describe('auto-mark', () => {
  it('adds a mark to an unmarked base-form instance', () => {
    const role = roleBase([
      form('word', [property('term', { base: 'text' }, { constraints: [hold('need')] })]),
    ])
    const ds = datasetOf([record({ type: 'word', mark: M1, fields: { term: text('foo') } })])
    // add an unmarked record
    ds.set('volatile', record({ type: 'word', fields: { term: text('bar') } }))
    const { dataset, added } = autoMark(ds, role)
    expect(added).toBe(1)
    // every record now has a valid mark
    for (const rec of dataset.values()) {
      expect(rec.mark).toBeDefined()
    }
  })
})
