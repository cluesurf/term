// The phase 4 criterion, end to end: a repository projects into a relational store,
// answers a query, and rebuilds from empty to an identical state.
//
// This drives a real Repository through the real change feed into the real SQL renderer.
// Only the engine is a double, so everything except the database driver is exercised.

import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { syncAsync } from '@term/base/code/project/feed'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'
const M3 = '33333333-3333-4333-8333-333333333333'

// The record form: what the author commits.
const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('gloss', { base: 'text' }),
  property('syllables', { base: 'integer' }),
])

// The table form: what the projection stores. The author declares both, and the mapping
// between them.
const wordTable: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'term', type: 'text', need: true },
    { name: 'gloss', type: 'text' },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [{ name: 'word_term', columns: ['term'], kind: 'plain' }],
}

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [
        { column: 'term', field: 'term' },
        { column: 'gloss', field: 'gloss' },
        { column: 'syllables', field: 'syllables' },
      ],
    },
  ],
}

function repo(): Repository {
  return new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    roleBase([wordForm]),
  )
}

function ds(records: Parameters<typeof datasetOf>[0]): Dataset {
  return datasetOf(records)
}

const meta = (time: number, message: string) => ({
  author: 'lance',
  time,
  message,
})

const word = (mark: string, term: string, gloss: string, syllables: number) =>
  record({
    type: 'word',
    mark,
    fields: {
      term: text(term),
      gloss: text(gloss),
      syllables: integer(syllables),
    },
  })

async function projectorOn(engine: MemoryEngine): Promise<Projector> {
  const projector = new Projector(engine, REPOSITORY, MAPPING)
  await projector.install([wordTable])
  return projector
}

/** A repository with three commits: two records added, one edited, one removed. */
function history(): { r: Repository; commits: Array<string> } {
  const r = repo()
  const c1 = r.commit(
    'main',
    meta(1, 'two words'),
    ds([word(M1, 'one', 'first', 1), word(M2, 'two', 'second', 2)]),
  )
  const c2 = r.commit(
    'main',
    meta(2, 'edit and add'),
    ds([
      word(M1, 'uno', 'first', 1),
      word(M2, 'two', 'second', 2),
      word(M3, 'three', 'third', 3),
    ]),
  )
  const c3 = r.commit(
    'main',
    meta(3, 'drop one'),
    ds([word(M1, 'uno', 'first', 1), word(M3, 'three', 'third', 3)]),
  )

  return { r, commits: [c1, c2, c3].map(String) }
}

describe('repository to relational projection', () => {
  it('projects a repository and serves its head', async () => {
    const { r } = history()
    const engine = new MemoryEngine()
    const projector = await projectorOn(engine)

    const served = await syncAsync(r, 'main', projector)

    expect(served).toBe(r.head('main'))
    expect(await projector.serving()).toBe(r.head('main'))
    expect(engine.dump('word')).toEqual([
      { gloss: 'first', mark: M1, syllables: '1', term: 'uno' },
      { gloss: 'third', mark: M3, syllables: '3', term: 'three' },
    ])
  })

  it('answers a query against the projection', async () => {
    const { r } = history()
    const engine = new MemoryEngine()
    await syncAsync(r, 'main', await projectorOn(engine))

    const rows = engine.dump('word').filter(row => row.syllables === '3')

    expect(rows).toEqual([
      { gloss: 'third', mark: M3, syllables: '3', term: 'three' },
    ])
  })

  it('advances incrementally rather than rebuilding, once it is caught up', async () => {
    const { r } = history()
    const engine = new MemoryEngine()
    const projector = await projectorOn(engine)

    await syncAsync(r, 'main', projector)
    const afterFirst = engine.statements.length

    r.commit(
      'main',
      meta(4, 'one more'),
      ds([
        word(M1, 'uno', 'first', 1),
        word(M3, 'three', 'third', 3),
        word(M2, 'two', 'again', 2),
      ]),
    )

    await syncAsync(r, 'main', projector)

    // an incremental advance writes a handful of statements, not the whole table again
    expect(engine.statements.length - afterFirst).toBeLessThan(6)
    expect(engine.dump('word')).toHaveLength(3)
    expect(await projector.serving()).toBe(r.head('main'))
  })

  it('writes one column update for a one-field edit', async () => {
    const { r } = history()
    const engine = new MemoryEngine()
    const projector = await projectorOn(engine)
    await syncAsync(r, 'main', projector)

    const before = engine.statements.length

    r.commit(
      'main',
      meta(5, 'change one gloss'),
      ds([word(M1, 'uno', 'CHANGED', 1), word(M3, 'three', 'third', 3)]),
    )
    await syncAsync(r, 'main', projector)

    const written = engine.statements.slice(before).filter(s => s.startsWith('UPDATE "word"'))

    expect(written).toHaveLength(1)
    expect(written[0]).toBe(
      'UPDATE "word" SET "gloss" = $1 WHERE "mark" = $2',
    )
  })

  it('rebuilds from empty to exactly the incrementally built state', async () => {
    const { r } = history()

    const incremental = new MemoryEngine()
    await syncAsync(r, 'main', await projectorOn(incremental))

    const head = r.head('main')!
    const fresh = new MemoryEngine()
    const rebuilt = await projectorOn(fresh)
    await rebuilt.rebuild({ commit: head, dataset: r.checkout(head) })

    expect(fresh.dump('word')).toEqual(incremental.dump('word'))
    expect(await rebuilt.serving()).toBe(head)
  })

  it('is a no-op when already at the head', async () => {
    const { r } = history()
    const engine = new MemoryEngine()
    const projector = await projectorOn(engine)

    await syncAsync(r, 'main', projector)
    const settled = engine.statements.length

    await syncAsync(r, 'main', projector)

    // one read to check the serving commit, and nothing written
    expect(engine.statements.length).toBe(settled)
  })

  it('projects nothing for a branch that does not exist', async () => {
    const engine = new MemoryEngine()
    const projector = await projectorOn(engine)

    expect(await syncAsync(repo(), 'main', projector)).toBeUndefined()
    expect(engine.dump('word')).toEqual([])
  })
})
