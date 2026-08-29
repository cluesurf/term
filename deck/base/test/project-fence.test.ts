// The watermark fence, and the completeness of the applied-commit log.
//
// Two properties that both fail SILENTLY when they are wrong, which is why they get their
// own file rather than a case tacked onto projector.test.ts:
//
//   the fence      two projectors advancing different spans must not leave the watermark
//                  naming a commit that does not describe the rows
//   `covers`       a span that folds forty commits must record forty, or read-your-writes
//                  denies commits whose data is already present
//
// See note/library/base/design/projection-sync-protocol.md, §6 and invariant I2.

import { describe, it, expect } from 'vitest'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import type { Change } from '@term/base/code/diff/change'
import { text } from '@term/base/code/base/make'
import type { RecordNode } from '@term/base/code/base/type'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const MARK_A = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const MARK_B = '0195f0e6-1c4a-7bd3-9f2e-000000000002'

const COMMIT_A = 'sha256:aaaa'
const COMMIT_B = 'sha256:bbbb'
const COMMIT_C = 'sha256:cccc'

const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'text', type: 'text', need: true },
  ],
  indexes: [],
}

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

function word(mark: string, value: string): RecordNode {
  return {
    mark,
    type: 'word',
    fields: new Map([['text', text(value)]]),
  }
}

function added(mark: string, value: string): Array<Change> {
  return [{ type: 'record.add', mark, value: word(mark, value) }]
}

async function install(): Promise<{ engine: MemoryEngine; projector: Projector }> {
  const engine = new MemoryEngine()
  const projector = new Projector(engine, REPOSITORY, MAPPING)
  await projector.install([FORM])

  return { engine, projector }
}

describe('the applied-commit log', () => {
  it('records every commit a span folds, not only its head', async () => {
    const { projector } = await install()

    // one write, carrying three commits: the shape a projector produces when it catches
    // up across a run rather than one commit at a time
    await projector.apply({
      commit: COMMIT_C,
      changes: added(MARK_A, 'one'),
      covers: [COMMIT_A, COMMIT_B, COMMIT_C],
    })

    expect(await projector.serving()).toBe(COMMIT_C)

    // the intermediate commits are the whole point: a client that committed B must read
    // its own write as applied rather than being told the projection is behind
    expect(await projector.hasApplied(COMMIT_A)).toBe(true)
    expect(await projector.hasApplied(COMMIT_B)).toBe(true)
    expect(await projector.hasApplied(COMMIT_C)).toBe(true)
  })

  it('logs only the head when covers is not supplied, which is why callers must supply it', async () => {
    const { projector } = await install()

    await projector.apply({ commit: COMMIT_C, changes: added(MARK_A, 'one') })

    expect(await projector.hasApplied(COMMIT_C)).toBe(true)
    // documents the default rather than endorsing it: catchUp passes covers precisely so
    // this case does not arise in production
    expect(await projector.hasApplied(COMMIT_B)).toBe(false)
  })
})

describe('the watermark fence', () => {
  it('advances when the watermark is where the caller left it', async () => {
    const { projector } = await install()

    const first = await projector.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      fence: { at: undefined },
    })

    expect(first.applied).toBe(true)
    expect(first.lost).toBeUndefined()

    const second = await projector.apply({
      commit: COMMIT_B,
      changes: added(MARK_B, 'two'),
      fence: { at: COMMIT_A },
    })

    expect(second.applied).toBe(true)
    expect(await projector.serving()).toBe(COMMIT_B)
  })

  it('refuses, and writes nothing at all, when another projector advanced first', async () => {
    const { engine, projector } = await install()

    await projector.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      fence: { at: undefined },
    })

    // the losing projector: it read `serving` as undefined, computed its span, and by the
    // time it writes, the watermark has moved to COMMIT_A
    const lost = await projector.apply({
      commit: COMMIT_B,
      changes: added(MARK_B, 'two'),
      fence: { at: undefined },
    })

    expect(lost.applied).toBe(false)
    expect(lost.lost).toBe(true)

    // the rows must roll back WITH the watermark. Committing them while the watermark
    // still names COMMIT_A is the exact split the fence exists to prevent, and it is
    // invisible without this assertion
    expect(engine.dump('word')).toHaveLength(1)
    expect(await projector.hasApplied(COMMIT_B)).toBe(false)
    expect(await projector.serving()).toBe(COMMIT_A)
  })

  it('fences a fresh projection like any other advance', async () => {
    const { projector } = await install()

    await projector.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      fence: { at: undefined },
    })

    // a second projector that also believed the projection was fresh. NULL has to compare
    // equal to NULL for the first advance to be guarded, and unequal to COMMIT_A here.
    const lost = await projector.apply({
      commit: COMMIT_C,
      changes: added(MARK_B, 'three'),
      fence: { at: undefined },
    })

    expect(lost.lost).toBe(true)
    expect(await projector.serving()).toBe(COMMIT_A)
  })

  it('still advances unfenced, so an existing caller is unaffected', async () => {
    const { projector } = await install()

    await projector.apply({ commit: COMMIT_A, changes: added(MARK_A, 'one') })

    const second = await projector.apply({
      commit: COMMIT_B,
      changes: added(MARK_B, 'two'),
    })

    expect(second.applied).toBe(true)
    expect(second.lost).toBeUndefined()
    expect(await projector.serving()).toBe(COMMIT_B)
  })
})
