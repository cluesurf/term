import { describe, it, expect } from 'vitest'
import { writesFor, mergeWrites } from '@term/base/code/project/write'
import type { Mapping } from '@term/base/code/project/mapping'
import { rowOf, tableFor, columnFor } from '@term/base/code/project/mapping'
import { parseTree } from '@term/base/code/tree/parse'
import { diffRecord } from '@term/base/code/diff/diff'
import { text, integer } from '@term/base/code/base/make'

const MARK = '0195f0e6-1c4a-7bd3-9f2e-4a1b8c7d6e5f'

// The author's mapping: `word` records project into a `word` table. `gloss` is
// deliberately unmapped, to prove a projection carries only what was asked for.
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

function record(fields: string): ReturnType<typeof parseTree> {
  return parseTree(`word hello\n  mark <${MARK}>\n${fields}`)
}

const BASE = record(
  '  text hello\n  syllables @integer 2\n  gloss greeting\n',
)

describe('mapping', () => {
  it('finds the table for a form', () => {
    expect(tableFor(MAPPING, 'word')?.table).toBe('word')
    expect(tableFor(MAPPING, 'phoneme')).toBeUndefined()
  })

  it('finds the column for a field', () => {
    expect(columnFor(MAPPING.tables[0]!, 'syllables')).toBe('syllables')
    expect(columnFor(MAPPING.tables[0]!, 'gloss')).toBeUndefined()
  })

  it('drops unmapped fields from the row', () => {
    const row = rowOf(MAPPING.tables[0]!, BASE)

    expect([...row.keys()].sort()).toEqual(['syllables', 'text'])
  })
})

describe('writesFor', () => {
  it('turns one field change into one column update', () => {
    const next = record(
      '  text hullo\n  syllables @integer 2\n  gloss greeting\n',
    )
    const writes = writesFor({
      mapping: MAPPING,
      changes: diffRecord(MARK, BASE, next),
    })

    expect(writes).toHaveLength(1)
    expect(writes[0]).toMatchObject({ type: 'update', table: 'word' })
    expect([...(writes[0] as { values: Map<string, unknown> }).values.keys()]).toEqual([
      'text',
    ])
  })

  it('ignores a change to an unmapped field', () => {
    const next = record(
      '  text hello\n  syllables @integer 2\n  gloss GREETING\n',
    )

    expect(
      writesFor({
        mapping: MAPPING,
        changes: diffRecord(MARK, BASE, next),
      }),
    ).toHaveLength(0)
  })

  it('ignores a record of an unmapped form', () => {
    expect(
      writesFor({
        mapping: MAPPING,
        changes: [
          {
            type: 'record.add',
            mark: MARK,
            value: {
              type: 'phoneme',
              fields: new Map([['symbol', text('p')]]),
            },
          },
        ],
      }),
    ).toHaveLength(0)
  })

  it('inserts a whole row for a new record', () => {
    const writes = writesFor({
      mapping: MAPPING,
      changes: [{ type: 'record.add', mark: MARK, value: BASE }],
    })

    expect(writes[0]).toMatchObject({
      type: 'insert',
      table: 'word',
      markColumn: 'mark',
    })
  })

  it('deletes the row for a removed record', () => {
    const writes = writesFor({
      mapping: MAPPING,
      changes: [{ type: 'record.remove', mark: MARK, before: BASE }],
    })

    expect(writes[0]).toMatchObject({ type: 'delete', table: 'word' })
  })

  it('clears a column when a field is removed', () => {
    const writes = writesFor({
      mapping: MAPPING,
      changes: [
        {
          type: 'field.remove',
          mark: MARK,
          field: 'text',
          before: text('hello'),
        },
      ],
    })

    expect(
      (writes[0] as { values: Map<string, unknown> }).values.get('text'),
    ).toBeUndefined()
  })
})

describe('mergeWrites', () => {
  it('collapses several field edits into one row write', () => {
    const next = record(
      '  text X\n  syllables @integer 9\n  gloss greeting\n',
    )
    const writes = writesFor({
      mapping: MAPPING,
      changes: diffRecord(MARK, BASE, next),
    })

    expect(writes.length).toBeGreaterThan(1)

    const merged = mergeWrites(writes)

    expect(merged).toHaveLength(1)
    expect(
      [...(merged[0] as { values: Map<string, unknown> }).values.keys()].sort(),
    ).toEqual(['syllables', 'text'])
  })

  it('lets a delete win, so an add-then-remove leaves no row', () => {
    const merged = mergeWrites([
      {
        type: 'insert',
        table: 'word',
        markColumn: 'mark',
        mark: MARK,
        values: new Map([['text', text('hello')]]),
      },
      { type: 'delete', table: 'word', markColumn: 'mark', mark: MARK },
    ])

    expect(merged).toHaveLength(1)
    expect(merged[0]!.type).toBe('delete')
  })

  it('keeps writes to different rows apart', () => {
    const other = '0195f0e6-1c4a-7bd3-9f2e-4a1b8c7d6e60'
    const merged = mergeWrites([
      {
        type: 'update',
        table: 'word',
        markColumn: 'mark',
        mark: MARK,
        values: new Map([['text', text('a')]]),
      },
      {
        type: 'update',
        table: 'word',
        markColumn: 'mark',
        mark: other,
        values: new Map([['syllables', integer(3)]]),
      },
    ])

    expect(merged).toHaveLength(2)
  })
})
