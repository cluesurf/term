import { describe, it, expect } from 'vitest'
import {
  check,
  contractOf,
  impact,
  readersOf,
  type Contract,
} from '@term/base/code/project/contract'
import { follow } from '@term/base/code/project/follow'
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

const REPO = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const M1 = '11111111-1111-4111-8111-111111111111'

const MAPPING: Mapping = {
  tables: [
    {
      form: 'word',
      table: 'word',
      markColumn: 'mark',
      columns: [
        { column: 'term', field: 'term' },
        { column: 'gloss', field: 'gloss' },
      ],
    },
  ],
}

const full = datasetOf([
  record({
    type: 'word',
    mark: M1,
    fields: { term: text('one'), gloss: text('first') },
  }),
])

// `gloss` dropped, the form still has records
const stripped = datasetOf([
  record({ type: 'word', mark: M1, fields: { term: text('one') } }),
])

describe('contractOf', () => {
  it('derives the contract from a projection mapping', () => {
    const contract = contractOf({ consumer: 'acme', mapping: MAPPING })

    expect(contract.consumer).toBe('acme')
    expect(contract.reads).toEqual([
      { form: 'word', property: 'term' },
      { form: 'word', property: 'gloss' },
    ])
  })
})

describe('check', () => {
  const contract = contractOf({ consumer: 'acme', mapping: MAPPING })

  it('follows when every property is present', () => {
    expect(check({ contract, dataset: full, at: 'c1' }).follow).toBe(true)
  })

  it('pins when a property is gone', () => {
    const verdict = check({ contract, dataset: stripped, at: 'c1' })

    expect(verdict.follow).toBe(false)
    expect(verdict.follow === false && verdict.gone).toEqual([
      { form: 'word', property: 'gloss', standing: 'gone' },
    ])
    expect(verdict.follow === false && verdict.pin).toBe('c1')
  })

  it('follows a rename, since a converter recovers it', () => {
    const renamed = datasetOf([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('one'), meaning: text('first') },
      }),
    ])

    const verdict = check({
      contract,
      dataset: renamed,
      derivation: { renames: [{ form: 'word', from: 'gloss', to: 'meaning' }] },
      at: 'c1',
    })

    expect(verdict.follow).toBe(true)
    expect(verdict.follow && verdict.derived).toHaveLength(1)
  })

  it('follows a property moved to another reachable form', () => {
    const split = datasetOf([
      record({ type: 'word', mark: M1, fields: { term: text('one') } }),
      record({
        type: 'sense',
        mark: '22222222-2222-4222-8222-222222222222',
        fields: { gloss: text('first') },
      }),
    ])

    const verdict = check({
      contract,
      dataset: split,
      derivation: { moved: [{ form: 'word', property: 'gloss', toForm: 'sense' }] },
      at: 'c1',
    })

    expect(verdict.follow).toBe(true)
  })

  it('does not pin on a form that merely has no records', () => {
    // an empty form is indistinguishable from a deleted one, and pinning every consumer
    // of a form with no rows today would be wrong in the expensive direction
    expect(
      check({ contract, dataset: datasetOf([]), at: 'c1' }).follow,
    ).toBe(true)
  })

  it('pins only the consumer whose property went, not everyone on the form', () => {
    const narrow: Contract = {
      consumer: 'reads-term-only',
      reads: [{ form: 'word', property: 'term' }],
    }

    expect(check({ contract: narrow, dataset: stripped, at: 'c1' }).follow).toBe(
      true,
    )
    expect(check({ contract, dataset: stripped, at: 'c1' }).follow).toBe(false)
  })
})

describe('impact', () => {
  it('reports exactly who breaks, before the change lands', () => {
    const contracts: Array<Contract> = [
      contractOf({ consumer: 'acme', mapping: MAPPING }),
      { consumer: 'narrow', reads: [{ form: 'word', property: 'term' }] },
    ]

    const result = impact({ contracts, dataset: stripped, at: 'c1' })

    expect(result.follow.map(v => v.consumer)).toEqual(['narrow'])
    expect(result.pinned.map(v => v.consumer)).toEqual(['acme'])
  })

  it('makes a deprecation a lookup', () => {
    const contracts: Array<Contract> = [
      contractOf({ consumer: 'acme', mapping: MAPPING }),
      { consumer: 'narrow', reads: [{ form: 'word', property: 'term' }] },
    ]

    expect(readersOf({ contracts, form: 'word', property: 'gloss' })).toEqual([
      'acme',
    ])
    expect(
      readersOf({ contracts, form: 'word', property: 'nobody_reads_this' }),
    ).toEqual([])
  })
})

describe('follow, with a contract', () => {
  const wordForm = form('word', [
    property('term', { base: 'text' }, { constraints: [hold('need')] }),
    property('gloss', { base: 'text' }),
  ])

  const TABLE: TableForm = {
    table: 'word',
    mark: 'mark',
    columns: [
      { name: 'mark', type: 'uuid', need: true },
      { name: 'term', type: 'text', need: true },
      { name: 'gloss', type: 'text' },
    ],
  }

  const meta = (t: number) => ({ author: 'lance', time: t, message: `c${t}` })

  async function setup() {
    const repo = new Repository(
      new MemoryChunkStore(),
      new MemoryRefStore(),
      roleBase([wordForm]),
    )
    const engine = new MemoryEngine()
    const projection = new Projector(engine, REPO, MAPPING)
    await projection.install([TABLE])
    return { repo, engine, projection }
  }

  const withGloss = (): Dataset =>
    datasetOf([
      record({
        type: 'word',
        mark: M1,
        fields: { term: text('one'), gloss: text('first') },
      }),
    ])

  const withoutGloss = (): Dataset =>
    datasetOf([record({ type: 'word', mark: M1, fields: { term: text('two') } })])

  it('refuses to advance past a commit that drops a property it reads', async () => {
    const { repo, projection } = await setup()
    repo.commit('main', meta(1), withGloss())
    const good = repo.head('main')

    let pinnedAt: string | undefined
    const follower = follow({
      repo,
      branch: 'main',
      projection,
      options: {
        contract: contractOf({ consumer: 'acme', mapping: MAPPING }),
        onPinned: v => {
          pinnedAt = v.follow === false ? v.pin : undefined
        },
      },
    })

    try {
      await follower.now()
      expect(await projection.serving()).toBe(good)

      // the restructuring lands
      repo.commit('main', meta(2), withoutGloss())
      await follower.now()

      // still on the last commit where the contract held, and it said so
      expect(await projection.serving()).toBe(good)
      expect(pinnedAt).toBe(good)
    } finally {
      follower.stop()
    }
  })

  it('follows the same commit when the contract does not name the dropped field', async () => {
    const { repo, projection } = await setup()
    repo.commit('main', meta(1), withGloss())

    const follower = follow({
      repo,
      branch: 'main',
      projection,
      options: {
        contract: { consumer: 'narrow', reads: [{ form: 'word', property: 'term' }] },
      },
    })

    try {
      await follower.now()
      repo.commit('main', meta(2), withoutGloss())
      await follower.now()

      expect(await projection.serving()).toBe(repo.head('main'))
    } finally {
      follower.stop()
    }
  })

  it('reports a pin once, not on every attempt', async () => {
    const { repo, projection } = await setup()
    repo.commit('main', meta(1), withGloss())
    let reports = 0

    const follower = follow({
      repo,
      branch: 'main',
      projection,
      options: {
        contract: contractOf({ consumer: 'acme', mapping: MAPPING }),
        onPinned: () => {
          reports += 1
        },
      },
    })

    try {
      await follower.now()
      repo.commit('main', meta(2), withoutGloss())
      await follower.now()
      await follower.now()
      await follower.now()

      expect(reports).toBe(1)
    } finally {
      follower.stop()
    }
  })

  it('without a contract, the column is silently emptied rather than left stale', async () => {
    // The behaviour the contract exists to prevent, pinned here so a regression is loud.
    // `field.remove` IS applied, so the column goes NULL rather than holding an old
    // value. That is not staleness, it is silent data loss from the consumer's side, and
    // the lag contract cannot see it: the projection is serving the newest commit and
    // reports itself perfectly healthy.
    const { repo, engine, projection } = await setup()
    repo.commit('main', meta(1), withGloss())

    const follower = follow({ repo, branch: 'main', projection })

    try {
      await follower.now()
      expect(engine.dump('word')[0]?.gloss).toBe('first')

      repo.commit('main', meta(2), withoutGloss())
      await follower.now()

      expect(await projection.serving()).toBe(repo.head('main'))
      expect(engine.dump('word')[0]?.gloss).toBeNull()
    } finally {
      follower.stop()
    }
  })
})
