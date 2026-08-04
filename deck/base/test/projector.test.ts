import { describe, it, expect } from 'vitest'
import { Projector } from '@term/base/code/project/projector'
import type { Mapping } from '@term/base/code/project/mapping'
import type { TableForm } from '@term/base/code/project/table'
import { validateTableForm } from '@term/base/code/project/table'
import { createTable } from '@term/base/code/project/ddl'
import { datasetOf } from '@term/base/code/diff/change'
import type { Change } from '@term/base/code/diff/change'
import { text, integer } from '@term/base/code/base/make'
import type { RecordNode } from '@term/base/code/base/type'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'
const A = '0195f0e6-1c4a-7bd3-9f2e-000000000001'
const B = '0195f0e6-1c4a-7bd3-9f2e-000000000002'
const C = '0195f0e6-1c4a-7bd3-9f2e-000000000003'

const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'text', type: 'text', need: true },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [{ name: 'word_text', columns: ['text'], kind: 'plain' }],
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
    fields: new Map<string, ReturnType<typeof text>>([
      ['text', text(value)],
      ['syllables', integer(syllables)],
    ]),
  }
}

async function install(): Promise<{ engine: MemoryEngine; projector: Projector }> {
  const engine = new MemoryEngine()
  const projector = new Projector(engine, REPOSITORY, MAPPING)
  await projector.install([FORM])
  return { engine, projector }
}

describe('table forms', () => {
  it('accepts a valid form', () => {
    expect(validateTableForm(FORM)).toEqual([])
  })

  it('requires the mark column to be a uuid', () => {
    const problems = validateTableForm({
      ...FORM,
      columns: [{ name: 'mark', type: 'text' }, ...FORM.columns.slice(1)],
    })

    expect(problems.join(' ')).toMatch(/must be uuid/)
  })

  it('rejects an index on an unknown column', () => {
    const problems = validateTableForm({
      ...FORM,
      indexes: [{ name: 'bad', columns: ['nope'], kind: 'plain' }],
    })

    expect(problems.join(' ')).toMatch(/unknown column/)
  })

  it('rejects an inverted index on a scalar column', () => {
    const problems = validateTableForm({
      ...FORM,
      indexes: [{ name: 'bad', columns: ['text'], kind: 'inverted' }],
    })

    expect(problems.join(' ')).toMatch(/needs a json or array column/)
  })

  it('rejects an array of json, which is already a container', () => {
    const problems = validateTableForm({
      ...FORM,
      columns: [...FORM.columns, { name: 'extra', type: 'json', array: true }],
    })

    expect(problems.join(' ')).toMatch(/already a container/)
  })
})

describe('ddl', () => {
  it('renders the portable types per engine', () => {
    const postgres = createTable({ form: FORM, dialect: 'postgres' })[0]!
    const cockroach = createTable({ form: FORM, dialect: 'cockroach' })[0]!

    expect(postgres).toMatch(/"text" TEXT NOT NULL/)
    expect(postgres).toMatch(/"syllables" BIGINT/)
    expect(cockroach).toMatch(/"text" STRING NOT NULL/)
    expect(cockroach).toMatch(/"syllables" INT8/)
  })

  it('makes the mark the primary key', () => {
    expect(createTable({ form: FORM, dialect: 'postgres' })[0]).toMatch(
      /PRIMARY KEY \("mark"\)/,
    )
  })

  it('emits index statements after the table', () => {
    const statements = createTable({ form: FORM, dialect: 'postgres' })

    expect(statements).toHaveLength(2)
    expect(statements[1]).toMatch(/CREATE INDEX "word_text" ON "word" \("text"\)/)
  })

  it('renders a partial index with its closed-vocabulary condition', () => {
    const statements = createTable({
      dialect: 'postgres',
      form: {
        ...FORM,
        indexes: [
          {
            name: 'long_words',
            columns: ['text'],
            kind: 'partial',
            where: { kind: 'compare', op: '>', column: 'syllables', value: 2 },
          },
        ],
      },
    })

    expect(statements[1]).toMatch(/WHERE "syllables" > 2/)
  })

  it('escapes a literal rather than interpolating it', () => {
    const statements = createTable({
      dialect: 'postgres',
      form: {
        ...FORM,
        checks: [
          {
            name: 'not_bad',
            expression: { kind: 'compare', op: '<>', column: 'text', value: "o'brien" },
          },
        ],
      },
    })

    expect(statements[0]).toMatch(/'o''brien'/)
  })

  it('refuses an unsafe identifier', () => {
    expect(() =>
      createTable({
        dialect: 'postgres',
        form: { ...FORM, table: 'word"; DROP TABLE x; --' },
      }),
    ).toThrow(/unsafe identifier/)
  })

  it('refuses to generate ddl from an invalid form', () => {
    expect(() =>
      createTable({
        dialect: 'postgres',
        form: { ...FORM, mark: 'missing' },
      }),
    ).toThrow(/is not valid/)
  })
})

describe('projector', () => {
  it('serves nothing before anything is applied', async () => {
    const { projector } = await install()

    expect(await projector.serving()).toBeUndefined()
  })

  it('applies a commit and advances the serving commit', async () => {
    const { engine, projector } = await install()

    const result = await projector.apply({
      commit: 'commit-1',
      changes: [{ type: 'record.add', mark: A, value: word(A, 'hello', 2) }],
    })

    expect(result).toEqual({ applied: true, writes: 1 })
    expect(await projector.serving()).toBe('commit-1')
    expect(engine.dump('word')).toEqual([
      { mark: A, syllables: '2', text: 'hello' },
    ])
  })

  it('is idempotent, so a retry cannot double-apply', async () => {
    const { engine, projector } = await install()
    const commit = {
      commit: 'commit-1',
      changes: [
        { type: 'record.add', mark: A, value: word(A, 'hello', 2) },
      ] as Array<Change>,
    }

    await projector.apply(commit)
    const again = await projector.apply(commit)

    expect(again).toEqual({ applied: false, writes: 0 })
    expect(engine.dump('word')).toHaveLength(1)
  })

  it('applies a field change as one column update', async () => {
    const { engine, projector } = await install()

    await projector.apply({
      commit: 'c1',
      changes: [{ type: 'record.add', mark: A, value: word(A, 'hello', 2) }],
    })
    await projector.apply({
      commit: 'c2',
      changes: [
        {
          type: 'field.set',
          mark: A,
          field: 'text',
          before: text('hello'),
          after: text('hullo'),
        },
      ],
    })

    expect(engine.dump('word')).toEqual([
      { mark: A, syllables: '2', text: 'hullo' },
    ])
    expect(await projector.serving()).toBe('c2')
  })

  it('removes a row when a record is removed', async () => {
    const { engine, projector } = await install()

    await projector.apply({
      commit: 'c1',
      changes: [{ type: 'record.add', mark: A, value: word(A, 'hello', 2) }],
    })
    await projector.apply({
      commit: 'c2',
      changes: [{ type: 'record.remove', mark: A, before: word(A, 'hello', 2) }],
    })

    expect(engine.dump('word')).toEqual([])
  })

  it('rolls back every row write when one statement in the commit fails', async () => {
    const engine = new MemoryEngine()
    // a second form pointing at a table that is never created, so the write fails midway
    const projector = new Projector(engine, REPOSITORY, {
      tables: [
        ...MAPPING.tables,
        {
          form: 'phoneme',
          table: 'phoneme',
          markColumn: 'mark',
          columns: [{ column: 'symbol', field: 'symbol' }],
        },
      ],
    })
    await projector.install([FORM])

    await projector.apply({
      commit: 'c1',
      changes: [{ type: 'record.add', mark: A, value: word(A, 'hello', 2) }],
    })

    await expect(
      projector.apply({
        commit: 'c2',
        changes: [
          { type: 'record.add', mark: B, value: word(B, 'good', 1) },
          {
            type: 'record.add',
            mark: C,
            value: { mark: C, type: 'phoneme', fields: new Map([['symbol', text('p')]]) },
          },
        ],
      }),
    ).rejects.toThrow(/no such table: phoneme/)

    // the word row from the same failed commit must not survive
    expect(engine.dump('word')).toEqual([
      { mark: A, syllables: '2', text: 'hello' },
    ])
    // and the commit must not be recorded, or it would never be retried
    expect(await projector.serving()).toBe('c1')
    expect(await projector.hasApplied('c2')).toBe(false)
  })

  it('rebuilds from empty to the same state incremental application produced', async () => {
    const incremental = await install()
    const commits: Array<{ commit: string; changes: Array<Change> }> = [
      {
        commit: 'c1',
        changes: [
          { type: 'record.add', mark: A, value: word(A, 'one', 1) },
          { type: 'record.add', mark: B, value: word(B, 'two', 2) },
        ],
      },
      {
        commit: 'c2',
        changes: [
          { type: 'field.set', mark: A, field: 'text', before: text('one'), after: text('uno') },
          { type: 'record.add', mark: C, value: word(C, 'three', 3) },
        ],
      },
      {
        commit: 'c3',
        changes: [{ type: 'record.remove', mark: B, before: word(B, 'two', 2) }],
      },
    ]

    await incremental.projector.applyAll(commits)

    // the repository's state at c3, which is what a rebuild is given
    const dataset = datasetOf([word(A, 'uno', 1), word(C, 'three', 3)])

    const fresh = await install()
    await fresh.projector.rebuild({ commit: 'c3', dataset })

    expect(fresh.engine.dump('word')).toEqual(incremental.engine.dump('word'))
    expect(await fresh.projector.serving()).toBe('c3')
    expect(await incremental.projector.serving()).toBe('c3')
  })

  it('rebuilds deterministically, so two rebuilds are indistinguishable', async () => {
    const dataset = datasetOf([word(C, 'three', 3), word(A, 'one', 1), word(B, 'two', 2)])

    const first = await install()
    await first.projector.rebuild({ commit: 'c9', dataset })

    const second = await install()
    await second.projector.rebuild({ commit: 'c9', dataset })

    expect(second.engine.dump('word')).toEqual(first.engine.dump('word'))
  })

  it('clears prior rows on rebuild, so a stale row cannot survive', async () => {
    const { engine, projector } = await install()

    await projector.apply({
      commit: 'c1',
      changes: [{ type: 'record.add', mark: A, value: word(A, 'stale', 1) }],
    })

    await projector.rebuild({
      commit: 'c2',
      dataset: datasetOf([word(B, 'fresh', 1)]),
    })

    expect(engine.dump('word')).toEqual([
      { mark: B, syllables: '1', text: 'fresh' },
    ])
  })

  it('lets a rebuilt projection replay later commits without double-applying', async () => {
    const { projector, engine } = await install()

    await projector.rebuild({
      commit: 'c1',
      dataset: datasetOf([word(A, 'one', 1)]),
    })

    // c1 was folded into the rebuild, so replaying it must be a no-op
    expect(
      await projector.apply({
        commit: 'c1',
        changes: [{ type: 'record.add', mark: A, value: word(A, 'WRONG', 9) }],
      }),
    ).toEqual({ applied: false, writes: 0 })

    expect(engine.dump('word')).toEqual([
      { mark: A, syllables: '1', text: 'one' },
    ])
  })

  it('ignores a record whose form is not projected', async () => {
    const { engine, projector } = await install()

    await projector.apply({
      commit: 'c1',
      changes: [
        {
          type: 'record.add',
          mark: A,
          value: { mark: A, type: 'phoneme', fields: new Map([['symbol', text('p')]]) },
        },
      ],
    })

    expect(engine.dump('word')).toEqual([])
    // still recorded, so the projection does not re-attempt it forever
    expect(await projector.serving()).toBe('c1')
  })
})
