// Erasure has to reach the projection.
//
// This is the one change where "eventually consistent" is not an acceptable answer, because
// the obligation is legal rather than operational. "Erased in base" is not the claim that
// matters. The claim that matters is "erased everywhere it was projected", and a projection
// is the copy an actual reader reads.
//
// A redaction is a COMMIT whose record becomes a tombstone, so it travels the ordinary
// change feed rather than needing a path of its own. That is the design working, and it is
// also why it needs a test: nothing about it looks like erasure from the projector's side,
// so a change that quietly stopped propagating tombstones would look like ordinary
// behaviour.
//
// Two properties, and the second is the one people get wrong:
//
//   incremental   projecting the redaction commit clears the content
//   REBUILT       rebuilding the repository from scratch does NOT bring it back
//
// A rebuild that resurrects erased content would undo the erasure silently, months later,
// during an operation performed for an unrelated reason.
//
// See note/library/base/design/projection-sync-protocol.md §9.3.

import { describe, it, expect } from 'vitest'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { redactInDataset, isRedacted } from '@term/base/code/redact/redact'
import { commitChanges } from '@term/base/code/project/feed'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const KEEP = '11111111-1111-4111-8111-111111111111'
const ERASE = '22222222-2222-4222-8222-222222222222'

// `gloss` and `term` are optional here on purpose. A tombstone clears the content, so a
// column the form insists on would make erasure impossible to project.
const wordForm = form('word', [
  property('term', { base: 'text' }),
  property('gloss', { base: 'text' }),
  property('syllables', { base: 'integer' }),
  property('redacted', { base: 'boolean' }),
  property('reason', { base: 'text' }),
  property('by', { base: 'text' }),
  property('time', { base: 'integer' }),
])

const wordTable: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'term', type: 'text' },
    { name: 'gloss', type: 'text' },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [],
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

const meta = (time: number, message: string) => ({
  author: 'lance',
  time,
  message,
})

const word = (mark: string, term: string, gloss: string) =>
  record({
    type: 'word',
    mark,
    fields: {
      term: text(term),
      gloss: text(gloss),
      syllables: integer(2),
    },
  })

function repositoryWithAnErasure(): { repo: Repository; head: string } {
  const repo = new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    roleBase([wordForm]),
  )

  const first = repo.commit(
    'main',
    meta(1, 'two words'),
    datasetOf([word(KEEP, 'keep', 'stays'), word(ERASE, 'erase', 'must go')]),
  )

  expect(first.ok).toBe(true)

  // the erasure itself: a commit, like any other, replacing the record with a tombstone
  const erased = redactInDataset(repo.checkoutBranch('main'), ERASE, {
    reason: 'right to erasure',
    by: 'lance',
    time: 2,
  })

  const second = repo.commit('main', meta(2, 'erase on request'), erased)

  expect(second.ok).toBe(true)

  return { repo, head: repo.head('main')! }
}

async function project(): Promise<{
  engine: MemoryEngine
  repo: Repository
  head: string
}> {
  const { repo, head } = repositoryWithAnErasure()
  const engine = new MemoryEngine()
  const projector = new Projector(engine, REPOSITORY, MAPPING)

  await projector.install([wordTable])

  return { engine, repo, head }
}

function rowFor(engine: MemoryEngine, mark: string): Record<string, unknown> | undefined {
  return engine.dump('word').find(row => row.mark === mark)
}

describe('an erasure reaching the projection', () => {
  it('is a tombstone in base, keeping the mark so citations still resolve', () => {
    const { repo, head } = repositoryWithAnErasure()
    const erased = repo.recordAt(head, ERASE)

    expect(erased).toBeDefined()
    expect(isRedacted(erased!)).toBe(true)
    // the content is gone, not the identity. A dangling reference would be a second problem
    expect(erased!.fields.get('gloss')).toBeUndefined()
    expect(erased!.fields.get('term')).toBeUndefined()
  })

  it('clears the projected content when the redaction commit is applied', async () => {
    // The INCREMENTAL path, walking commit by commit, which is how a live projection meets
    // an erasure. The rebuild path is covered below, and they have to agree.
    const { engine, repo, head } = await project()
    const projector = new Projector(engine, REPOSITORY, MAPPING)
    const log = [...repo.log('main')].reverse().map(entry => entry.hash)

    let at: string | undefined

    for (const commit of log) {
      await projector.apply({
        commit,
        changes: commitChanges(repo, at, commit),
        covers: [commit],
      })

      at = commit
    }

    expect(at).toBe(head)

    const kept = rowFor(engine, KEEP)
    const gone = rowFor(engine, ERASE)

    expect(kept?.term).toBe('keep')

    // the row may remain, since the mark is not erased, but its CONTENT must not
    expect(gone?.term ?? null).toBeNull()
    expect(gone?.gloss ?? null).toBeNull()
    expect(JSON.stringify(engine.dump('word'))).not.toContain('must go')
  })

  it('does NOT resurrect the content on a rebuild from scratch', async () => {
    // The property that matters most and is easiest to lose. A rebuild reads the dataset at
    // a commit rather than replaying history, so it sees the tombstone and never the
    // original. If it read history instead, an erasure would be undone by any rebuild.
    const { engine, repo, head } = await project()
    const projector = new Projector(engine, REPOSITORY, MAPPING)

    await projector.rebuild({ commit: head, dataset: repo.checkout(head) })

    const gone = rowFor(engine, ERASE)

    expect(rowFor(engine, KEEP)?.term).toBe('keep')
    expect(gone?.term ?? null).toBeNull()
    expect(gone?.gloss ?? null).toBeNull()

    // and nothing anywhere in the projected rows still carries the erased content
    expect(JSON.stringify(engine.dump('word'))).not.toContain('must go')
  })

  it('leaves an erasure applied even after a later rebuild at the same commit', async () => {
    const { engine, repo, head } = await project()
    const projector = new Projector(engine, REPOSITORY, MAPPING)

    await projector.rebuild({ commit: head, dataset: repo.checkout(head) })
    await projector.rebuild({ commit: head, dataset: repo.checkout(head) })

    expect(JSON.stringify(engine.dump('word'))).not.toContain('must go')
  })
})
