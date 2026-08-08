import { describe, it, expect } from 'vitest'
import { admit, health } from '@term/base/code/project/lag'
import type { LagState } from '@term/base/code/project/lag'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import type { Change } from '@term/base/code/diff/change'
import { text, integer } from '@term/base/code/base/make'
import type { RecordNode } from '@term/base/code/base/type'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const A = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const B = '0195f0e6-1c4a-7bd3-9f2e-000000000002'
const NOW = 1_800_000_000_000

const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'text', type: 'text', need: true },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [{ name: 'by_syllables', columns: ['syllables'], kind: 'plain' }],
}

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [
        { column: 'text', field: 'text' },
        { column: 'syllables', field: 'syllables' },
      ],
    },
  ],
}

function word(mark: string, value: string, syllables: number): RecordNode {
  return {
    mark,
    type: 'word',
    fields: new Map([
      ['text', text(value)],
      ['syllables', integer(syllables)],
    ]),
  }
}

// a controllable clock, so lag is exercised without waiting
function clock(start = NOW): { now: () => number; advance: (ms: number) => void } {
  let at = start
  return { now: () => at, advance: ms => (at += ms) }
}

async function install(now: () => number = () => NOW) {
  const engine = new MemoryEngine()
  const projector = new Projector(engine, REPOSITORY, MAPPING, now)
  await projector.install([FORM])
  return { engine, projector }
}

const add = (mark: string, value: string, syllables: number): Change => ({
  type: 'record.add',
  mark,
  value: word(mark, value, syllables),
})

describe('health', () => {
  const state = (over: Partial<LagState> = {}): LagState => ({
    serving: 'c1',
    appliedAt: NOW,
    ...over,
  })

  it('treats a never-applied projection as unhealthy, not merely empty', () => {
    const result = health({ state: state({ serving: undefined }), now: NOW })

    expect(result.healthy).toBe(false)
    expect(result).toMatchObject({ reason: 'never-applied' })
  })

  it('is healthy with no bound', () => {
    expect(health({ state: state(), now: NOW + 10_000_000 }).healthy).toBe(true)
  })

  it('is unhealthy past its age bound', () => {
    const result = health({
      state: state(),
      bound: { maxAgeMs: 1_000 },
      now: NOW + 5_000,
    })

    expect(result).toMatchObject({ healthy: false, reason: 'too-old' })
  })

  it('is healthy inside its age bound', () => {
    expect(
      health({ state: state(), bound: { maxAgeMs: 10_000 }, now: NOW + 5_000 })
        .healthy,
    ).toBe(true)
  })

  it('is unhealthy too many commits behind the head', () => {
    const result = health({
      state: state({ behind: 12 }),
      bound: { maxCommits: 5 },
      now: NOW,
    })

    expect(result).toMatchObject({ healthy: false, reason: 'too-far-behind' })
  })

  it('says how far past the bound it is, so the report is actionable', () => {
    const result = health({
      state: state(),
      bound: { maxAgeMs: 1_000 },
      now: NOW + 5_000,
    })

    expect(result.healthy).toBe(false)
    expect((result as { detail: string }).detail).toMatch(/5000ms.*1000ms/)
  })
})

describe('admit', () => {
  const state: LagState = { serving: 'c1', appliedAt: NOW }

  it('serves an undemanding read', () => {
    expect(
      admit({ state, freshness: { need: 'any' }, now: NOW }),
    ).toMatchObject({ ok: true, serving: 'c1' })
  })

  it('serves a demand the projection has met', () => {
    expect(
      admit({
        state,
        freshness: { need: 'commit', commit: 'c1' },
        hasCommit: true,
        now: NOW,
      }),
    ).toMatchObject({ ok: true })
  })

  it('refuses a demand the projection has not met', () => {
    expect(
      admit({
        state,
        freshness: { need: 'commit', commit: 'c9' },
        hasCommit: false,
        now: NOW,
      }),
    ).toMatchObject({ ok: false, reason: 'behind-demand' })
  })

  it('reports unhealthy before behind-demand, so an outage does not read as a race', () => {
    const result = admit({
      state,
      bound: { maxAgeMs: 1_000 },
      freshness: { need: 'commit', commit: 'c9' },
      hasCommit: false,
      now: NOW + 5_000,
    })

    expect(result).toMatchObject({ ok: false, reason: 'too-old' })
  })
})

describe('reading through the lag contract', () => {
  it('refuses to answer before anything is applied', async () => {
    const { projector } = await install()

    const result = await projector.read({ form: FORM, query: {} })

    expect(result.ok).toBe(false)
    expect(result).toMatchObject({ reason: 'never-applied' })
  })

  it('answers with the commit it was served at', async () => {
    const { projector } = await install()
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })

    const result = await projector.read({ form: FORM, query: {} })

    expect(result).toMatchObject({ ok: true, serving: 'c1' })
    expect(result.ok && result.rows).toHaveLength(1)
  })

  it('gives read-your-writes after a commit', async () => {
    const { projector } = await install()
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })

    const met = await projector.read({
      form: FORM,
      query: {},
      freshness: { need: 'commit', commit: 'c1' },
    })
    expect(met.ok).toBe(true)

    const unmet = await projector.read({
      form: FORM,
      query: {},
      freshness: { need: 'commit', commit: 'c2' },
    })
    expect(unmet).toMatchObject({ ok: false, reason: 'behind-demand' })

    // once c2 lands, the same demand is met
    await projector.apply({ commit: 'c2', changes: [add(B, 'two', 2)] })
    const now = await projector.read({
      form: FORM,
      query: {},
      freshness: { need: 'commit', commit: 'c2' },
    })
    expect(now).toMatchObject({ ok: true, serving: 'c2' })
  })

  it('refuses rather than answering when it has fallen past its bound', async () => {
    const time = clock()
    const { projector } = await install(time.now)
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })

    const fresh = await projector.read({
      form: FORM,
      query: {},
      bound: { maxAgeMs: 60_000 },
    })
    expect(fresh.ok).toBe(true)

    time.advance(120_000)

    const stale = await projector.read({
      form: FORM,
      query: {},
      bound: { maxAgeMs: 60_000 },
    })
    expect(stale).toMatchObject({ ok: false, reason: 'too-old' })
    // and it carries no rows at all, rather than stale ones
    expect('rows' in stale).toBe(false)
  })

  it('refuses when too many commits behind the head', async () => {
    const { projector } = await install()
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })

    const result = await projector.read({
      form: FORM,
      query: {},
      bound: { maxCommits: 2 },
      behind: 9,
    })

    expect(result).toMatchObject({ ok: false, reason: 'too-far-behind' })
  })

  it('filters, and reports the index that served the read', async () => {
    const { projector } = await install()
    await projector.apply({
      commit: 'c1',
      changes: [add(A, 'one', 1), add(B, 'two', 2)],
    })

    const result = await projector.read({
      form: FORM,
      query: { where: [{ column: 'syllables', op: '=', value: integer(2) }] },
    })

    expect(result.ok).toBe(true)
    expect(result.ok && result.rows).toEqual([
      { mark: B, text: 'two', syllables: '2' },
    ])
    expect(result.plan?.index).toBe('by_syllables')
  })

  it('orders and limits', async () => {
    const { projector } = await install()
    await projector.apply({
      commit: 'c1',
      changes: [add(A, 'one', 1), add(B, 'two', 2)],
    })

    const result = await projector.read({
      form: FORM,
      query: {
        order: { column: 'syllables', direction: 'descending' },
        limit: 1,
      },
    })

    expect(result.ok && result.rows).toEqual([
      { mark: B, text: 'two', syllables: '2' },
    ])
  })

  it('reports health separately, so a caller can check before asking', async () => {
    const time = clock()
    const { projector } = await install(time.now)

    expect((await projector.health()).healthy).toBe(false)

    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })
    expect((await projector.health()).healthy).toBe(true)

    time.advance(120_000)
    expect((await projector.health({ maxAgeMs: 60_000 })).healthy).toBe(false)
  })

  it('advances the applied time with each commit', async () => {
    const time = clock()
    const { projector } = await install(time.now)

    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })
    const first = await projector.lagState()

    time.advance(30_000)
    await projector.apply({ commit: 'c2', changes: [add(B, 'two', 2)] })
    const second = await projector.lagState()

    expect(second.appliedAt! - first.appliedAt!).toBe(30_000)
  })

  it('reads freshness and rows in ONE transaction', async () => {
    const { engine, projector } = await install()
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })

    engine.transactions = 0
    const result = await projector.read({
      form: FORM,
      query: {},
      freshness: { need: 'commit', commit: 'c1' },
    })

    expect(result.ok).toBe(true)
    // split across transactions, a concurrent apply could land between them and the
    // answer would report a serving commit that does not describe the rows it carries
    expect(engine.transactions).toBe(1)
  })
})

describe('read-your-writes across a batched advance', () => {
  it('records every commit folded into one apply, not just the head', async () => {
    const { projector } = await install()

    // a batched advance from empty to c3 that folds c1, c2, c3 into one change set
    // (as the follow/sync path does): all three must be recorded as applied
    await projector.apply({
      commit: 'c3',
      changes: [add(A, 'one', 1), add(B, 'two', 2)],
      covers: ['c1', 'c2', 'c3'],
    })

    expect(await projector.hasApplied('c1')).toBe(true)
    expect(await projector.hasApplied('c2')).toBe(true) // the intermediate commit
    expect(await projector.hasApplied('c3')).toBe(true)
    // and the served commit is the head
    expect(await projector.serving()).toBe('c3')
  })

  it('defaults covers to just the commit when not batched', async () => {
    const { projector } = await install()
    await projector.apply({ commit: 'c1', changes: [add(A, 'one', 1)] })
    expect(await projector.hasApplied('c1')).toBe(true)
    expect(await projector.hasApplied('c2')).toBe(false)
  })
})
