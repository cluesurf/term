import { describe, it, expect } from 'vitest'
import { follow, pollingSignal, pushSignal } from '@term/base/code/project/follow'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { record, text, integer } from '@term/base/code/base/make'
import { datasetOf, type Dataset } from '@term/base/code/diff/change'
import { form, property, hold, roleBase } from '@term/base/code/form/form'
import { MemoryChunkStore } from '@term/base/code/store/chunk-store'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { Repository } from '@term/base/code/repo/repo'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const M1 = '11111111-1111-4111-8111-111111111111'
const M2 = '22222222-2222-4222-8222-222222222222'

const wordForm = form('word', [
  property('term', { base: 'text' }, { constraints: [hold('need')] }),
  property('syllables', { base: 'integer' }),
])

const TABLE: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'term', type: 'text', need: true },
    { name: 'syllables', type: 'integer' },
  ],
}

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [
        { column: 'term', field: 'term' },
        { column: 'syllables', field: 'syllables' },
      ],
    },
  ],
}

const word = (mark: string, term: string, syllables: number) =>
  record({
    type: 'word',
    mark,
    fields: { term: text(term), syllables: integer(syllables) },
  })

const meta = (time: number) => ({ author: 'lance', time, message: `c${time}` })

function repo(): Repository {
  return new Repository(
    new MemoryChunkStore(),
    new MemoryRefStore(),
    roleBase([wordForm]),
  )
}

const ds = (records: Parameters<typeof datasetOf>[0]): Dataset =>
  datasetOf(records)

async function projector(): Promise<{
  engine: MemoryEngine
  projection: Projector
}> {
  const engine = new MemoryEngine()
  const projection = new Projector(engine, REPOSITORY, MAPPING)
  await projection.install([TABLE])
  return { engine, projection }
}

// let queued microtasks and immediate timers drain
const settle = (): Promise<void> =>
  new Promise(resolve => setTimeout(resolve, 5))

describe('follow', () => {
  it('catches up immediately rather than waiting for the first interval', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { engine, projection } = await projector()

    const follower = follow({ repo: r, branch: 'main', projection })

    try {
      await follower.now()
      expect(engine.dump('word')).toHaveLength(1)
      expect(await projection.serving()).toBe(r.head('main'))
    } finally {
      follower.stop()
    }
  })

  it('advances when a push signal fires', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { engine, projection } = await projector()
    const signal = pushSignal()
    const advanced: string[] = []

    const follower = follow({
      repo: r,
      branch: 'main',
      projection,
      signal,
      options: { onAdvance: c => advanced.push(c) },
    })

    try {
      await follower.now()
      expect(engine.dump('word')).toHaveLength(1)

      r.commit('main', meta(2), ds([word(M1, 'one', 1), word(M2, 'two', 2)]))
      signal.wake()
      await settle()

      expect(engine.dump('word')).toHaveLength(2)
      expect(advanced).toHaveLength(2)
    } finally {
      follower.stop()
    }
  })

  it('reports the served commit on each advance, and only on a real one', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { projection } = await projector()
    const advanced: string[] = []

    const follower = follow({
      repo: r,
      branch: 'main',
      projection,
      options: { onAdvance: c => advanced.push(c) },
    })

    try {
      await follower.now()
      await follower.now()
      await follower.now()

      // three attempts, one actual move
      expect(advanced).toEqual([r.head('main')])
    } finally {
      follower.stop()
    }
  })

  it('keeps following after an error rather than stopping', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { projection } = await projector()
    const errors: unknown[] = []

    let failures = 2
    const brittle = {
      apply: projection.apply.bind(projection),
      rebuild: async (input: { commit: string; dataset: Dataset }) => {
        if (failures-- > 0) {
          throw new Error('transient')
        }
        return projection.rebuild(input)
      },
      serving: projection.serving.bind(projection),
    }

    const follower = follow({
      repo: r,
      branch: 'main',
      projection: brittle,
      options: { onError: e => errors.push(e) },
    })

    try {
      await follower.now()
      await follower.now()
      expect(errors).toHaveLength(2)

      // a stopped follower would never recover; this one does
      await follower.now()
      expect(await projection.serving()).toBe(r.head('main'))
    } finally {
      follower.stop()
    }
  })

  it('does not overlap attempts, so a slow apply is not re-entered', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { projection } = await projector()

    let inFlight = 0
    let maxInFlight = 0
    const slow = {
      apply: projection.apply.bind(projection),
      serving: projection.serving.bind(projection),
      rebuild: async (input: { commit: string; dataset: Dataset }) => {
        inFlight += 1
        maxInFlight = Math.max(maxInFlight, inFlight)
        await new Promise(r => setTimeout(r, 20))
        const out = await projection.rebuild(input)
        inFlight -= 1
        return out
      },
    }

    const follower = follow({ repo: r, branch: 'main', projection: slow })

    try {
      await Promise.all([follower.now(), follower.now(), follower.now()])
      expect(maxInFlight).toBe(1)
    } finally {
      follower.stop()
    }
  })

  it('stops cleanly, and stopping twice is safe', async () => {
    const r = repo()
    r.commit('main', meta(1), ds([word(M1, 'one', 1)]))
    const { engine, projection } = await projector()
    const signal = pushSignal()

    const follower = follow({ repo: r, branch: 'main', projection, signal })
    await follower.now()
    follower.stop()
    follower.stop()

    const before = engine.dump('word').length
    r.commit('main', meta(2), ds([word(M1, 'one', 1), word(M2, 'two', 2)]))
    signal.wake()
    await settle()

    expect(engine.dump('word')).toHaveLength(before)
  })
})

describe('pollingSignal', () => {
  it('wakes only when the head actually changes', async () => {
    let head: string | undefined = 'a'
    let wakes = 0

    const stop = pollingSignal({ head: async () => head, every: 5 }).listen(
      () => {
        wakes += 1
      },
    )

    try {
      await settle()
      const afterFirst = wakes
      expect(afterFirst).toBe(1)

      await settle()
      expect(wakes).toBe(afterFirst) // unchanged head, no wake

      head = 'b'
      await new Promise(r => setTimeout(r, 20))
      expect(wakes).toBe(afterFirst + 1)
    } finally {
      stop()
    }
  })

  it('survives a failing head read', async () => {
    let fail = true
    let wakes = 0

    const stop = pollingSignal({
      every: 5,
      head: async () => {
        if (fail) {
          throw new Error('network')
        }
        return 'a'
      },
    }).listen(() => {
      wakes += 1
    })

    try {
      await settle()
      expect(wakes).toBe(0)

      fail = false
      await new Promise(r => setTimeout(r, 20))
      expect(wakes).toBeGreaterThan(0)
    } finally {
      stop()
    }
  })
})
