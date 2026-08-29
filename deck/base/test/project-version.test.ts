// The mapping version.
//
// A mapping is derived by introspecting the target schema and then cached, so a migration
// that adds a column changes it, and until the projector notices, that column is silently
// never written: it exists, it is null on every row, and nothing reports a problem. The
// projection is genuinely current with every commit and stale in a way the lag contract
// cannot see, because lag is about commits and this is about shape.
//
// Two properties matter. The version must be STABLE, or every restart looks like a
// migration and the signal is trained away. And it must MOVE whenever the rows a projection
// writes would differ, or it reports safety it does not have.

import { describe, it, expect } from 'vitest'
import {
  changed,
  compareMappings,
  describeChange,
  mappingVersion,
} from '@term/base/code/project/version'
import type { Mapping } from '@term/base/code/project/mapping'
import { Projector } from '@term/base/code/project/projector'
import type { TableForm } from '@term/base/code/project/table'
import { MemoryEngine } from './project-engine'

const REPOSITORY = '0195f0e6-0000-7bd3-9f2e-00000000000a'

const BASE: Mapping = {
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

const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'text', type: 'text', need: true },
    { name: 'syllables', type: 'integer' },
  ],
  indexes: [],
}

const WITH_COLUMN: Mapping = {
  tables: [
    {
      ...BASE.tables[0]!,
      columns: [...BASE.tables[0]!.columns, { column: 'gloss', field: 'gloss' }],
    },
  ],
}

describe('the mapping version', () => {
  it('is stable across two derivations of the same shape', () => {
    expect(mappingVersion(BASE)).toBe(mappingVersion({ tables: [...BASE.tables] }))
  })

  it('does not depend on the order the schema was introspected in', () => {
    // information_schema returns rows in whatever order it likes. If that leaked into the
    // version, every restart would look like a migration.
    const forward: Mapping = {
      tables: [
        BASE.tables[0]!,
        { form: 'sense', table: 'sense', markColumn: 'mark', columns: [] },
      ],
    }
    const backward: Mapping = {
      tables: [forward.tables[1]!, forward.tables[0]!],
    }

    expect(mappingVersion(forward)).toBe(mappingVersion(backward))
  })

  it('does not depend on column order within a table', () => {
    const reversed: Mapping = {
      tables: [
        { ...BASE.tables[0]!, columns: [...BASE.tables[0]!.columns].reverse() },
      ],
    }

    expect(mappingVersion(BASE)).toBe(mappingVersion(reversed))
  })

  it('moves when a column is added', () => {
    expect(mappingVersion(BASE)).not.toBe(mappingVersion(WITH_COLUMN))
  })

  it('moves when a field lands in a different column', () => {
    const renamed: Mapping = {
      tables: [
        {
          ...BASE.tables[0]!,
          columns: [
            { column: 'text_value', field: 'text' },
            { column: 'syllables', field: 'syllables' },
          ],
        },
      ],
    }

    expect(mappingVersion(BASE)).not.toBe(mappingVersion(renamed))
  })

  it('moves when the mark column changes', () => {
    const other: Mapping = {
      tables: [{ ...BASE.tables[0]!, markColumn: 'id' }],
    }

    expect(mappingVersion(BASE)).not.toBe(mappingVersion(other))
  })
})

describe('comparing two mappings', () => {
  it('names an added column, which means every existing row has a null there', () => {
    const change = compareMappings({ before: BASE, after: WITH_COLUMN })

    expect(change.addedColumns).toEqual([{ table: 'word', column: 'gloss' }])
    expect(change.removedColumns).toEqual([])
    expect(changed(change)).toBe(true)
  })

  it('names a removed column, which means its values are frozen while looking live', () => {
    const change = compareMappings({ before: WITH_COLUMN, after: BASE })

    expect(change.removedColumns).toEqual([{ table: 'word', column: 'gloss' }])
    expect(change.addedColumns).toEqual([])
  })

  it('reports a rename as one of each, rather than guessing', () => {
    const renamed: Mapping = {
      tables: [
        {
          ...BASE.tables[0]!,
          columns: [
            { column: 'text_value', field: 'text' },
            { column: 'syllables', field: 'syllables' },
          ],
        },
      ],
    }
    const change = compareMappings({ before: BASE, after: renamed })

    expect(change.addedColumns).toEqual([{ table: 'word', column: 'text_value' }])
    expect(change.removedColumns).toEqual([{ table: 'word', column: 'text' }])
  })

  it('names added and removed tables', () => {
    const more: Mapping = {
      tables: [
        ...BASE.tables,
        { form: 'sense', table: 'sense', markColumn: 'mark', columns: [] },
      ],
    }

    expect(compareMappings({ before: BASE, after: more }).addedTables).toEqual(['sense'])
    expect(compareMappings({ before: more, after: BASE }).removedTables).toEqual(['sense'])
  })

  it('reports no change for the same mapping', () => {
    const change = compareMappings({ before: BASE, after: BASE })

    expect(changed(change)).toBe(false)
    expect(describeChange(change)).toBe('no change')
  })

  it('describes a change in one line', () => {
    expect(describeChange(compareMappings({ before: BASE, after: WITH_COLUMN }))).toBe(
      '+word.gloss',
    )
  })
})

describe('a projection carrying its mapping version', () => {
  it('stamps the version alongside the watermark', async () => {
    const engine = new MemoryEngine()
    const projector = new Projector(engine, REPOSITORY, BASE)

    await projector.install([FORM])
    await projector.apply({ commit: 'sha256:aaaa', changes: [] })

    const state = await projector.mappingState()

    expect(state.stored).toBe(mappingVersion(BASE))
    expect(state.matches).toBe(true)
  })

  it('reports a mismatch when the schema moved under the projection', async () => {
    const engine = new MemoryEngine()

    await new Projector(engine, REPOSITORY, BASE).install([FORM])
    await new Projector(engine, REPOSITORY, BASE).apply({
      commit: 'sha256:aaaa',
      changes: [],
    })

    // the same projection, now derived from a schema that gained a column
    const after = new Projector(engine, REPOSITORY, WITH_COLUMN)
    const state = await after.mappingState()

    expect(state.matches).toBe(false)
    expect(state.stored).toBe(mappingVersion(BASE))
    expect(state.current).toBe(mappingVersion(WITH_COLUMN))
  })

  it('treats a projection that predates versioning as unknown, not as a mismatch', async () => {
    // Otherwise every existing projection would report a mismatch the first time this
    // ships, and the first thing anyone learns about the signal is that it cried wolf.
    const engine = new MemoryEngine()
    const projector = new Projector(engine, REPOSITORY, BASE)

    await projector.install([FORM])

    const state = await projector.mappingState()

    expect(state.stored).toBeUndefined()
    expect(state.matches).toBe(true)
  })
})
