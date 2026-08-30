// An array column, from a record's collection value to a database parameter.
//
// `font.panose` is a `smallint[]`, and it was dropped on every row: the mapping had no entry
// for an array, so the column never reached base at all. Found 2026-08-30 by
// `pnpm check:roundtrip`, and it was the ONLY array column across the six cut-over tables,
// so the omission cost exactly one field and would have cost the next one just as silently.
//
// The part that has to be right is the PARAMETER. A collection bound for an array column must
// become a JS array, which every driver renders as a Postgres array. Stringified, it is
// `'[0,0,5]'`, which is a valid json value and an invalid `int2[]`, so the two forms fail in
// opposite directions and neither failure mentions the other.
//
// A renderer cannot tell an `int2[]` from an `int2` by looking at a value, so the mapping
// carries the array-ness and the write passes it through. That is why this is typed rather
// than sniffed from the value's shape.

import { describe, it, expect } from 'vitest'
import { toParam, toStatement } from '@term/base/code/project/sql'
import { writesFor } from '@term/base/code/project/write'
import type { Mapping } from '@term/base/code/project/mapping'
import type { Change } from '@term/base/code/diff/change'
import type { RecordNode, Value } from '@term/base/code/base/type'

const MARK = '8f2b1c30-4d5e-4a71-b3c6-9e0f2a7d4415'

const PANOSE: Value = {
  kind: 'collection',
  order: 'list',
  items: [0, 0, 5, 0].map(one => ({
    value: { kind: 'integer', value: BigInt(one) } as Value,
  })),
}

const MAPPING: Mapping = {
  tables: [
    {
      form: 'font',
      table: 'font',
      markColumn: 'id',
      columns: [
        { column: 'slug', field: 'slug' },
        { column: 'panose', field: 'panose', array: true },
      ],
    },
  ],
}

function fontRecord(): RecordNode {
  return {
    mark: MARK,
    type: 'font',
    fields: new Map<string, Value>([
      ['slug', { kind: 'text', value: 'inter' }],
      ['panose', PANOSE],
    ]),
  }
}

describe('a collection bound for an array column', () => {
  it('becomes a JS array, not a JSON string', () => {
    expect(toParam(PANOSE, true)).toEqual(['0', '0', '5', '0'])
  })

  it('is still a JSON string when the column is not an array', () => {
    // The existing behaviour, kept: a container with no column type of its own lands in a
    // json column, and changing that would break every record field that is a nested shape.
    expect(typeof toParam(PANOSE, false)).toBe('string')
  })

  it('keeps integers exact, as strings, the same way a scalar integer does', () => {
    // `integer` is a bigint, which no driver accepts uniformly, so it travels as text and
    // the column's own type converts it. An array must not quietly use a different rule, or
    // a 64-bit element loses precision where a 64-bit column does not.
    const big: Value = {
      kind: 'collection',
      order: 'list',
      items: [{ value: { kind: 'integer', value: 9007199254740993n } }],
    }

    expect(toParam(big, true)).toEqual(['9007199254740993'])
  })
})

describe('the write that carries it', () => {
  it('names the array columns from the mapping', () => {
    const changes: Array<Change> = [
      { type: 'record.add', mark: MARK, value: fontRecord() },
    ]

    const write = writesFor({ mapping: MAPPING, changes })[0]!

    expect(write.type).toBe('insert')
    expect(
      write.type === 'insert' && [...(write.arrays ?? [])],
    ).toEqual(['panose'])
  })

  it('renders the array column as an array parameter and the rest normally', () => {
    // The whole path, end to end: a record with a collection field produces a statement
    // whose parameter for that column is an array and whose other parameters are untouched.
    const changes: Array<Change> = [
      { type: 'record.add', mark: MARK, value: fontRecord() },
    ]

    const statement = toStatement(writesFor({ mapping: MAPPING, changes })[0]!)

    expect(statement.params[0]).toBe(MARK)
    expect(statement.params[1]).toBe('inter')
    expect(statement.params[2]).toEqual(['0', '0', '5', '0'])
  })

  it('carries no array set for a table that has none', () => {
    // Absent rather than empty, so nothing downstream has to distinguish "no arrays" from
    // "arrays not computed", and a mapping written by hand keeps working unchanged.
    const plain: Mapping = {
      tables: [
        {
          form: 'font',
          table: 'font',
          markColumn: 'id',
          columns: [{ column: 'slug', field: 'slug' }],
        },
      ],
    }

    const write = writesFor({
      mapping: plain,
      changes: [{ type: 'record.add', mark: MARK, value: fontRecord() }],
    })[0]!

    expect(write.type === 'insert' && write.arrays).toBeUndefined()
  })

  it('names the array column on a field update too, not only on an insert', () => {
    // A backfill inserts and an edit updates. Carrying the array set on one and not the
    // other would make the same column work on the way in and fail on the next change to it.
    const write = writesFor({
      mapping: MAPPING,
      changes: [
        {
          type: 'field.set',
          mark: MARK,
          field: 'panose',
          before: undefined,
          after: PANOSE,
        },
      ],
    })[0]!

    expect(write.type).toBe('update')
    expect(write.type === 'update' && [...(write.arrays ?? [])]).toEqual([
      'panose',
    ])
    expect(toStatement(write).params[0]).toEqual(['0', '0', '5', '0'])
  })
})
