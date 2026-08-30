// Recording that a projection was proved to rebuild.
//
// The rebuild proof is what licenses reading from a projection at all: it is the check that
// dropping the view tables and replaying base produces the same rows. It used to run and
// then forget, so nothing could tell a projection proved last night from one proved six
// months ago, and "we proved it" quietly became permanent.
//
// Three things have to hold for a recorded proof to mean anything.
//
//   an absent record must read as ABSENT, never as a proof at some default time, or a
//   projection nobody ever proved reports as proved
//
//   the record must name the TABLES it covered, because a run proves the tables it was
//   handed and an unqualified "proved" turns one table's proof into a claim about all of
//   them
//
//   a proof must not be confused with currency. It is a claim about a commit, and applying
//   further commits leaves it standing at the older commit rather than moving it along,
//   which is what makes a proof go stale visibly instead of silently.

import { describe, it, expect } from 'vitest'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '2c1f7a54-0d9e-4a63-9c8b-1f0a6d4e77b2'

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [{ column: 'text', field: 'text' }],
    },
  ],
}

const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'text', type: 'text' },
  ],
  indexes: [],
}

const MARK = '8f2b1c30-4d5e-4a71-b3c6-9e0f2a7d4415'

async function projectorAt(now: () => number): Promise<Projector> {
  const projector = new Projector(new MemoryEngine(), REPOSITORY, MAPPING, now)

  await projector.install([FORM])

  return projector
}

/** One commit, so the bookkeeping row exists to be updated. */
async function applyOne(projector: Projector, commit: string): Promise<void> {
  await projector.apply({
    commit,
    changes: [
      {
        type: 'field.set',
        mark: MARK,
        field: 'text',
        before: undefined,
        after: { kind: 'text', value: commit },
      },
    ],
  })
}

describe('recording a rebuild proof', () => {
  it('reads as absent until something proves it', async () => {
    const projector = await projectorAt(() => 1_000)

    await applyOne(projector, 'commit-one')

    // The distinction the whole item exists for. A projection nobody has proved must not
    // come back as proved at epoch, or at the time it was installed.
    expect(await projector.proof()).toBeUndefined()
  })

  it('records the commit, the time, and the tables covered', async () => {
    const projector = await projectorAt(() => 1_700_000_000_000)

    await applyOne(projector, 'commit-one')
    await projector.recordProof({ commit: 'commit-one', tables: ['word'] })

    expect(await projector.proof()).toEqual({
      commit: 'commit-one',
      at: 1_700_000_000_000,
      tables: ['word'],
    })
  })

  it('sorts and deduplicates the table list, so two records compare', async () => {
    const projector = await projectorAt(() => 5_000)

    await applyOne(projector, 'commit-one')
    await projector.recordProof({
      commit: 'commit-one',
      tables: ['sense', 'word', 'sense'],
    })

    expect((await projector.proof())?.tables).toEqual(['sense', 'word'])
  })

  it('stays at the proved commit when later commits are applied', async () => {
    // A proof is a claim about ONE commit. If applying commits moved it along, a projection
    // would report itself proved at a commit no rebuild ever checked, which is the failure
    // mode worth more than the feature: it would read as proved forever.
    const projector = await projectorAt(() => 9_000)

    await applyOne(projector, 'commit-one')
    await projector.recordProof({ commit: 'commit-one', tables: ['word'] })
    await applyOne(projector, 'commit-two')

    expect(await projector.serving()).toBe('commit-two')
    expect((await projector.proof())?.commit).toBe('commit-one')
  })

  it('keeps the standing proof when a later one supersedes it only on success', async () => {
    // Nothing here writes a failure, and that is the design: `recordProof` is called only on
    // a pass. "Last proved at X" and "last attempted at Y" are different facts, and letting a
    // failure overwrite the first would destroy the only evidence the projection was ever
    // trustworthy, at the exact moment somebody is looking for it.
    const projector = await projectorAt(() => 11_000)

    await applyOne(projector, 'commit-one')
    await projector.recordProof({ commit: 'commit-one', tables: ['word'] })
    await applyOne(projector, 'commit-two')

    expect((await projector.proof())?.commit).toBe('commit-one')

    await projector.recordProof({ commit: 'commit-two', tables: ['word'] })

    expect((await projector.proof())?.commit).toBe('commit-two')
  })
})
