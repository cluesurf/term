import { describe, it, expect } from 'vitest'
import { planQuery, toSelect } from '@term/base/code/project/query'
import type { Query } from '@term/base/code/project/query'
import type { TableForm } from '@term/base/code/project/table'
import { text, integer } from '@term/base/code/base/make'

// An author's declared schema: three indexes, each meant for a different read.
const FORM: TableForm = {
  table: 'word',
  mark: 'mark',
  columns: [
    { name: 'mark', type: 'uuid', need: true },
    { name: 'language', type: 'text', need: true },
    { name: 'text', type: 'text', need: true },
    { name: 'syllables', type: 'integer' },
    { name: 'retired', type: 'boolean' },
    { name: 'senses', type: 'json' },
  ],
  indexes: [
    { name: 'by_language_text', columns: ['language', 'text'], kind: 'plain' },
    { name: 'by_text', columns: ['text'], kind: 'unique' },
    { name: 'by_syllables', columns: ['syllables'], kind: 'plain' },
    {
      name: 'live_by_language',
      columns: ['language'],
      kind: 'partial',
      where: { kind: 'compare', op: '=', column: 'retired', value: false },
    },
    { name: 'by_senses', columns: ['senses'], kind: 'inverted' },
  ],
}

describe('planQuery', () => {
  it('uses a declared index for an equality query', () => {
    const plan = planQuery(FORM, {
      where: [{ column: 'syllables', op: '=', value: integer(2) }],
    })

    expect(plan.index).toBe('by_syllables')
    expect(plan.matched).toEqual(['syllables'])
  })

  it('prefers the index matching the longer leading prefix', () => {
    const plan = planQuery(FORM, {
      where: [
        { column: 'language', op: '=', value: text('tokipona') },
        { column: 'text', op: '=', value: text('jan') },
      ],
    })

    expect(plan.index).toBe('by_language_text')
    expect(plan.matched).toEqual(['language', 'text'])
  })

  it('uses a compound index on its leading column alone', () => {
    const plan = planQuery(FORM, {
      where: [{ column: 'language', op: '=', value: text('tokipona') }],
    })

    expect(plan.matched).toEqual(['language'])
  })

  it('will not use a compound index on a trailing column alone', () => {
    // `(language, text)` cannot serve `text = ?`, so the unique index on text must win
    const plan = planQuery(FORM, {
      where: [{ column: 'text', op: '=', value: text('jan') }],
    })

    expect(plan.index).toBe('by_text')
  })

  it('prefers a unique index when the prefix lengths tie', () => {
    const plan = planQuery(
      {
        ...FORM,
        indexes: [
          { name: 'plain_text', columns: ['text'], kind: 'plain' },
          { name: 'unique_text', columns: ['text'], kind: 'unique' },
        ],
      },
      { where: [{ column: 'text', op: '=', value: text('jan') }] },
    )

    expect(plan.index).toBe('unique_text')
  })

  it('reports a scan when nothing matches, rather than hiding it', () => {
    const plan = planQuery(FORM, {
      where: [{ column: 'retired', op: '=', value: text('no') }],
    })

    expect(plan.index).toBeUndefined()
    expect(plan.scan).toBe('no-index-matches')
  })

  it('does not treat a range as an index prefix', () => {
    const plan = planQuery(FORM, {
      where: [{ column: 'syllables', op: '>', value: integer(2) }],
    })

    expect(plan.index).toBeUndefined()
  })

  it('serves an in-list from an index, since it is still equality', () => {
    const plan = planQuery(FORM, {
      where: [
        { column: 'syllables', op: 'in', values: [integer(1), integer(2)] },
      ],
    })

    expect(plan.index).toBe('by_syllables')
  })

  it('uses a partial index only when the query states its condition', () => {
    const without = planQuery(FORM, {
      where: [{ column: 'language', op: '=', value: text('tokipona') }],
    })
    // the plain compound index applies; the partial one is not assumed
    expect(without.index).toBe('by_language_text')

    const withCondition = planQuery(
      { ...FORM, indexes: [FORM.indexes![3]!] },
      {
        where: [
          { column: 'language', op: '=', value: text('tokipona') },
          { column: 'retired', op: '=', value: { kind: 'boolean', value: false } },
        ],
      },
    )
    expect(withCondition.index).toBe('live_by_language')
  })

  it('refuses a partial index whose condition the query does not state', () => {
    const plan = planQuery(
      { ...FORM, indexes: [FORM.indexes![3]!] },
      { where: [{ column: 'language', op: '=', value: text('tokipona') }] },
    )

    expect(plan.index).toBeUndefined()
  })

  it('never picks an inverted index for a comparison', () => {
    const plan = planQuery(
      { ...FORM, indexes: [FORM.indexes![4]!] },
      { where: [{ column: 'senses', op: '=', value: text('x') }] },
    )

    expect(plan.index).toBeUndefined()
  })

  it('serves an unfiltered ordered read from an index on the sort column', () => {
    const plan = planQuery(FORM, {
      order: { column: 'syllables', direction: 'ascending' },
    })

    expect(plan.index).toBe('by_syllables')
  })

  it('reports a scan for an unfiltered read with no usable order', () => {
    expect(planQuery(FORM, {}).scan).toBe('no-conditions')
  })
})

describe('toSelect', () => {
  const render = (query: Query) => toSelect({ form: FORM, query })

  it('parameterizes every value', () => {
    const statement = render({
      where: [{ column: 'text', op: '=', value: text("o'brien") }],
    })

    expect(statement.sql).toBe('SELECT * FROM "word" WHERE "text" = $1')
    expect(statement.params).toEqual(["o'brien"])
  })

  it('numbers parameters across several conditions', () => {
    const statement = render({
      where: [
        { column: 'language', op: '=', value: text('tok') },
        { column: 'syllables', op: '>', value: integer(2) },
      ],
      limit: 10,
    })

    expect(statement.sql).toBe(
      'SELECT * FROM "word" WHERE "language" = $1 AND "syllables" > $2 LIMIT $3',
    )
    expect(statement.params).toEqual(['tok', '2', 10])
  })

  it('expands an in-list to one placeholder per value', () => {
    const statement = render({
      where: [{ column: 'text', op: 'in', values: [text('a'), text('b')] }],
    })

    expect(statement.sql).toContain('"text" IN ($1, $2)')
  })

  it('renders an empty in-list as FALSE rather than invalid SQL', () => {
    const statement = render({
      where: [{ column: 'text', op: 'in', values: [] }],
    })

    expect(statement.sql).toContain('WHERE FALSE')
    expect(statement.sql).not.toContain('IN ()')
  })

  it('renders order, limit, and offset', () => {
    const statement = render({
      order: { column: 'text', direction: 'descending' },
      limit: 5,
      offset: 10,
    })

    expect(statement.sql).toBe(
      'SELECT * FROM "word" ORDER BY "text" DESC LIMIT $1 OFFSET $2',
    )
    expect(statement.params).toEqual([5, 10])
  })

  it('selects only the named columns when asked', () => {
    const statement = toSelect({
      form: FORM,
      query: {},
      columns: ['mark', 'text'],
    })

    expect(statement.sql).toBe('SELECT "mark", "text" FROM "word"')
  })

  it('refuses a column the form does not declare', () => {
    expect(() =>
      render({ where: [{ column: 'sylables', op: '=', value: text('x') }] }),
    ).toThrow(/has no column `sylables`/)
  })

  it('refuses an injected column name, before it can reach the renderer', () => {
    expect(() =>
      render({
        where: [
          { column: 'text"; DROP TABLE word; --', op: '=', value: text('x') },
        ],
      }),
    ).toThrow(/has no column/)
  })

  it('refuses an unknown order or projection column too', () => {
    expect(() =>
      render({ order: { column: 'nope', direction: 'ascending' } }),
    ).toThrow(/has no column `nope`/)
    expect(() =>
      toSelect({ form: FORM, query: {}, columns: ['nope'] }),
    ).toThrow(/has no column `nope`/)
  })

  it('prefers an equality over a range on the same column', () => {
    // a range listed first must not hide the equality that makes the index usable
    const plan = planQuery(FORM, {
      where: [
        { column: 'syllables', op: '>', value: integer(1) },
        { column: 'syllables', op: '=', value: integer(3) },
      ],
    })

    expect(plan.index).toBe('by_syllables')
  })

  it('will not match a partial index on an integer too large to compare exactly', () => {
    const form = {
      ...FORM,
      indexes: [
        {
          name: 'big',
          columns: ['language'] as Array<string>,
          kind: 'partial' as const,
          // beyond the exact double range
          where: {
            kind: 'compare' as const,
            op: '=' as const,
            column: 'syllables',
            value: 9007199254740993,
          },
        },
      ],
    }

    const plan = planQuery(form, {
      where: [
        { column: 'language', op: '=', value: text('tok') },
        { column: 'syllables', op: '=', value: integer(9007199254740993n) },
      ],
    })

    // rounding would make these look equal and select an index that omits rows
    expect(plan.index).toBeUndefined()
  })
})
