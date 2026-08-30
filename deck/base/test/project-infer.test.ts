// Working out a projection's schema from the records themselves.
//
// Deriving a mapping normally means introspecting a database that already has the tables,
// which is useless for the case this exists for: somebody holds a repository and wants its
// contents in a fresh database. There is no schema to read.
//
// The naive version of this loses something quietly at three points, so those three are
// what the tests are about rather than the happy path.

import { describe, it, expect } from 'vitest'
import {
  MixedField,
  inferProjection,
} from '@term/base/code/project/infer'
import { boolean, integer, list, nul, record, text } from '@term/base/code/base/make'
import type { Dataset } from '@term/base/code/diff/change'
import type { RecordNode } from '@term/base/code/base/type'

function datasetOf(...records: Array<RecordNode>): Dataset {
  const out: Dataset = new Map()

  records.forEach((one, index) => {
    out.set(one.mark ?? `mark-${index}`, one)
  })

  return out
}

function word(mark: string, fields: Record<string, ReturnType<typeof text>>) {
  return record({ type: 'word', mark, fields })
}

describe('inferring a table from records', () => {
  it('makes a form a table and a field a column', () => {
    const { mapping, forms } = inferProjection({
      dataset: datasetOf(word('a', { text: text('hello'), count: integer(3) })),
    })

    expect(mapping.tables).toHaveLength(1)
    expect(mapping.tables[0]?.table).toBe('word')
    expect(mapping.tables[0]?.markColumn).toBe('mark')
    expect(forms[0]?.columns.map(one => [one.name, one.type])).toEqual([
      ['mark', 'uuid'],
      ['count', 'integer'],
      ['text', 'text'],
    ])
  })

  it('is deterministic: forms and columns come out sorted', () => {
    // Two runs over the same records must give the same schema, or a mapping cannot be
    // compared, committed, or diffed against the one already deployed.
    const one = inferProjection({
      dataset: datasetOf(
        record({ type: 'sense', mark: 'b', fields: { z: text('1'), a: text('2') } }),
        word('a', { text: text('x') }),
      ),
    })
    const two = inferProjection({
      dataset: datasetOf(
        word('a', { text: text('x') }),
        record({ type: 'sense', mark: 'b', fields: { a: text('2'), z: text('1') } }),
      ),
    })

    expect(JSON.stringify(one)).toBe(JSON.stringify(two))
    expect(one.mapping.tables.map(t => t.table)).toEqual(['sense', 'word'])
  })
})

describe('what the records say about nullability', () => {
  it('marks a field present on every record NOT NULL', () => {
    const { forms } = inferProjection({
      dataset: datasetOf(
        word('a', { text: text('one') }),
        word('b', { text: text('two') }),
      ),
    })

    expect(forms[0]?.columns.find(one => one.name === 'text')?.need).toBe(true)
  })

  it('leaves a field absent from some records nullable', () => {
    // Real information the records carry. A projection that made everything nullable would
    // throw it away, and one that made everything NOT NULL would refuse to load.
    const { forms } = inferProjection({
      dataset: datasetOf(
        word('a', { text: text('one'), gloss: text('g') }),
        word('b', { text: text('two') }),
      ),
    })

    const gloss = forms[0]?.columns.find(one => one.name === 'gloss')

    expect(gloss?.need).toBeUndefined()
  })
})

describe('what a null value does not decide', () => {
  it('does not let a null vote on the column type', () => {
    // A null says the field is empty, not what it would hold. Letting it vote would make
    // the first empty row decide the column, and the row order is not meaningful.
    const { forms } = inferProjection({
      dataset: datasetOf(
        word('a', { count: nul() }),
        word('b', { count: integer(7) }),
      ),
    })

    expect(forms[0]?.columns.find(one => one.name === 'count')?.type).toBe(
      'integer',
    )
  })

  it('falls back to text for a field that is null everywhere', () => {
    // Nothing to go on. Text rather than refusing, so one empty column cannot block a
    // whole import.
    const { forms } = inferProjection({
      dataset: datasetOf(word('a', { note: nul() })),
    })

    expect(forms[0]?.columns.find(one => one.name === 'note')?.type).toBe('text')
  })
})

describe('a field that holds two kinds', () => {
  it('is refused, by name, with both kinds', () => {
    // Widening to text would let a source with an integer in one row and a word in another
    // produce a table that no longer knows which, and the mistake surfaces as a query
    // returning nothing much later.
    expect(() =>
      inferProjection({
        dataset: datasetOf(
          word('a', { size: integer(1) }),
          word('b', { size: text('large') }),
        ),
      }),
    ).toThrow(MixedField)

    try {
      inferProjection({
        dataset: datasetOf(
          word('a', { size: integer(1) }),
          word('b', { size: text('large') }),
        ),
      })
    } catch (error) {
      expect((error as MixedField).form).toBe('word')
      expect((error as MixedField).field).toBe('size')
      expect((error as Error).message).toContain('integer')
      expect((error as Error).message).toContain('text')
    }
  })

  it('does not confuse two forms that use one field name differently', () => {
    // `size` is an integer on one form and text on another. They are different tables and
    // must not collide.
    const { forms } = inferProjection({
      dataset: datasetOf(
        word('a', { size: integer(1) }),
        record({ type: 'shirt', mark: 'b', fields: { size: text('large') } }),
      ),
    })

    expect(forms.find(one => one.table === 'word')?.columns[1]?.type).toBe(
      'integer',
    )
    expect(forms.find(one => one.table === 'shirt')?.columns[1]?.type).toBe(
      'text',
    )
  })
})

describe('a collection', () => {
  it('becomes an array column of its element type', () => {
    const { mapping, forms } = inferProjection({
      dataset: datasetOf(
        word('a', {
          codes: list([{ value: integer(1) }, { value: integer(2) }]),
        }),
      ),
    })

    const column = forms[0]?.columns.find(one => one.name === 'codes')

    expect(column?.type).toBe('integer')
    expect(column?.array).toBe(true)
    // and the MAPPING carries it too, because the statement builder is what needs it
    expect(mapping.tables[0]?.columns[0]?.array).toBe(true)
  })

  it('takes its element type from a later record when the first is empty', () => {
    // An empty collection says nothing about its elements, so it must not settle the type.
    const { forms } = inferProjection({
      dataset: datasetOf(
        word('a', { codes: list([]) }),
        word('b', { codes: list([{ value: boolean(true) }]) }),
      ),
    })

    expect(forms[0]?.columns.find(one => one.name === 'codes')?.type).toBe(
      'boolean',
    )
  })
})

describe('the mark', () => {
  it('is a uuid column and comes first', () => {
    const { forms } = inferProjection({
      dataset: datasetOf(word('a', { text: text('x') })),
    })

    expect(forms[0]?.columns[0]).toEqual({
      name: 'mark',
      type: 'uuid',
      need: true,
    })
  })

  it('takes the name the caller gives it', () => {
    const { mapping, forms } = inferProjection({
      dataset: datasetOf(word('a', { text: text('x') })),
      markColumn: 'id',
    })

    expect(mapping.tables[0]?.markColumn).toBe('id')
    expect(forms[0]?.columns[0]?.name).toBe('id')
  })

  it('never lets a FIELD of the mark column name become a column', () => {
    // The mark is the row's identity and is written from the record's mark. A field of the
    // same name claiming that column would let a record overwrite which row it is.
    const { mapping, forms } = inferProjection({
      dataset: datasetOf(word('a', { mark: text('not the mark'), text: text('x') })),
    })

    expect(mapping.tables[0]?.columns.map(one => one.column)).toEqual(['text'])
    expect(forms[0]?.columns.map(one => one.name)).toEqual(['mark', 'text'])
  })
})
