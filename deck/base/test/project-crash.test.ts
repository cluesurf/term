// Crash safety mid-apply.
//
// The bookkeeping row is what makes a restart cheap, and it is also what makes a restart
// CORRECT. If the watermark could advance before the row writes land, a crash between them
// would silently skip a commit, and the projection would be wrong forever with no error
// anywhere: the rows for that commit simply never appear, and the projection reports itself
// current because the watermark says so.
//
// The transaction argument that rules this out is sound on paper and was never exercised.
// This kills a projector partway through an apply and asserts the two properties a restart
// needs: nothing partial survives, and the retry applies exactly once.
//
// See note/library/base/design/projection-sync-protocol.md invariant I4, and
// note/library/base/project/base-projection.json base-projection-0006.

import { describe, it, expect } from 'vitest'
import { Projector } from '@term/base/code/project/projector'
import type { Engine, Transaction } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import type { Change } from '@term/base/code/diff/change'
import { text } from '@term/base/code/base/make'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const MARK_A = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const MARK_B = '0195f0e6-1c4a-7bd3-9f2e-000000000002'
const COMMIT_A = 'sha256:aaaa'
const COMMIT_B = 'sha256:bbbb'

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

function added(mark: string, value: string): Change[] {
  return [
    {
      type: 'record.add',
      mark,
      value: { mark, type: 'word', fields: new Map([['text', text(value)]]) },
    },
  ]
}

/**
 * An engine that dies partway through a transaction.
 *
 * It delegates to a real `MemoryEngine`, so the rollback under test is the engine's own
 * rather than something this harness simulates. `die` counts WRITE statements only: reads
 * are how the projector checks itself, and failing one would test a different thing.
 */
class CrashingEngine implements Engine {
  crashed = false

  constructor(
    private readonly inner: MemoryEngine,
    private readonly die: number,
  ) {}

  get dialect(): MemoryEngine['dialect'] {
    return this.inner.dialect
  }

  async transact<T>(body: (tx: Transaction) => Promise<T>): Promise<T> {
    let writes = 0

    return this.inner.transact(async (tx: Transaction) => {
      return body({
        run: async statement => {
          writes += 1

          if (writes > this.die) {
            this.crashed = true

            throw new Error('the projector process died')
          }

          await tx.run(statement)
        },
        all: statement => tx.all(statement),
      })
    })
  }
}

describe('a projector that dies mid-apply', () => {
  it('leaves nothing behind, and the retry applies exactly once', async () => {
    const memory = new MemoryEngine()

    // install first, on a healthy engine, so the crash under test is the apply and not the DDL
    await new Projector(memory, REPOSITORY, MAPPING).install([FORM])

    // dies after one write, which lands inside the row writes and before the bookkeeping
    const crashing = new CrashingEngine(memory, 1)
    const dying = new Projector(crashing, REPOSITORY, MAPPING)

    await expect(
      dying.apply({
        commit: COMMIT_A,
        changes: [...added(MARK_A, 'one'), ...added(MARK_B, 'two')],
        covers: [COMMIT_A],
      }),
    ).rejects.toThrow(/died/)

    expect(crashing.crashed).toBe(true)

    // NOTHING partial survives. A row without its watermark would be invisible work; a
    // watermark without its rows would be the silent skip this test exists to rule out.
    const healthy = new Projector(memory, REPOSITORY, MAPPING)

    expect(memory.dump('word')).toHaveLength(0)
    expect(await healthy.serving()).toBeUndefined()
    expect(await healthy.hasApplied(COMMIT_A)).toBe(false)

    // the restart, which must not skip the commit the crash swallowed
    const retry = await healthy.apply({
      commit: COMMIT_A,
      changes: [...added(MARK_A, 'one'), ...added(MARK_B, 'two')],
      covers: [COMMIT_A],
    })

    expect(retry.applied).toBe(true)
    expect(memory.dump('word')).toHaveLength(2)
    expect(await healthy.serving()).toBe(COMMIT_A)

    // and applying the same commit again is a no-op rather than a double write
    const again = await healthy.apply({
      commit: COMMIT_A,
      changes: [...added(MARK_A, 'one'), ...added(MARK_B, 'two')],
      covers: [COMMIT_A],
    })

    expect(again.applied).toBe(false)
    expect(memory.dump('word')).toHaveLength(2)
  })

  it('does not lose an earlier commit when a later one dies', async () => {
    const memory = new MemoryEngine()
    const healthy = new Projector(memory, REPOSITORY, MAPPING)

    await healthy.install([FORM])
    await healthy.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      covers: [COMMIT_A],
    })

    const crashing = new CrashingEngine(memory, 1)
    const dying = new Projector(crashing, REPOSITORY, MAPPING)

    await expect(
      dying.apply({
        commit: COMMIT_B,
        changes: [...added(MARK_B, 'two'), ...added(MARK_A, 'edited')],
        covers: [COMMIT_B],
      }),
    ).rejects.toThrow(/died/)

    // the projection falls back to exactly where it was, which is what makes a crash a
    // delay rather than a corruption
    expect(await healthy.serving()).toBe(COMMIT_A)
    expect(await healthy.hasApplied(COMMIT_A)).toBe(true)
    expect(await healthy.hasApplied(COMMIT_B)).toBe(false)
    expect(memory.dump('word')).toHaveLength(1)
    expect(memory.dump('word')[0]!.text).toBe('one')
  })

  it('rolls a rebuild back too, rather than leaving the projection emptied', async () => {
    // A rebuild deletes every mapped table before it writes. If a crash between those could
    // commit, the projection would be left EMPTY while its watermark still named a commit,
    // which reads as "this form has no rows" rather than as a failure.
    const memory = new MemoryEngine()
    const healthy = new Projector(memory, REPOSITORY, MAPPING)

    await healthy.install([FORM])
    await healthy.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      covers: [COMMIT_A],
    })

    const crashing = new CrashingEngine(memory, 2)
    const dying = new Projector(crashing, REPOSITORY, MAPPING)

    await expect(
      dying.rebuild({
        commit: COMMIT_B,
        dataset: new Map([
          [
            MARK_B,
            { mark: MARK_B, type: 'word', fields: new Map([['text', text('two')]]) },
          ],
        ]),
      }),
    ).rejects.toThrow(/died/)

    expect(memory.dump('word')).toHaveLength(1)
    expect(await healthy.serving()).toBe(COMMIT_A)
  })
})

describe('the quarantine', () => {
  it('starts clear, records a pin, and survives being read by another projector', async () => {
    const memory = new MemoryEngine()
    const projector = new Projector(memory, REPOSITORY, MAPPING)

    await projector.install([FORM])
    await projector.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      covers: [COMMIT_A],
    })

    expect(await projector.pinned()).toBeUndefined()

    await projector.pin({
      commit: COMMIT_B,
      reason: 'column `gloss` does not exist',
    })

    // read through a DIFFERENT projector, because the pin has to be a fact about the
    // projection rather than about the process that noticed it. A pin held only in memory
    // is retried on every restart, so the alert flaps and nobody learns anything.
    const other = new Projector(memory, REPOSITORY, MAPPING)

    expect(await other.pinned()).toEqual({
      commit: COMMIT_B,
      reason: 'column `gloss` does not exist',
    })
  })

  it('clears only when asked', async () => {
    const memory = new MemoryEngine()
    const projector = new Projector(memory, REPOSITORY, MAPPING)

    await projector.install([FORM])
    await projector.apply({ commit: COMMIT_A, changes: [], covers: [COMMIT_A] })
    await projector.pin({ commit: COMMIT_B, reason: 'bad' })
    await projector.unpin()

    expect(await projector.pinned()).toBeUndefined()
  })

  it('does not disturb the watermark it is protecting', async () => {
    // The whole point of pinning rather than skipping: the projection stays at the last
    // commit it could apply, so it is BEHIND rather than WRONG.
    const memory = new MemoryEngine()
    const projector = new Projector(memory, REPOSITORY, MAPPING)

    await projector.install([FORM])
    await projector.apply({
      commit: COMMIT_A,
      changes: added(MARK_A, 'one'),
      covers: [COMMIT_A],
    })
    await projector.pin({ commit: COMMIT_B, reason: 'bad' })

    expect(await projector.serving()).toBe(COMMIT_A)
    expect(await projector.hasApplied(COMMIT_A)).toBe(true)
    expect(memory.dump('word')).toHaveLength(1)
  })
})
