import { describe, it, expect } from 'vitest'
import {
  record,
  text,
  integer,
  boolean,
  ref,
  list,
  set,
  nested,
  item,
} from '@term/base/code/base/make'
import { canonicalizeRecord } from '@term/base/code/canon/canonicalize'
import { formatTree } from '@term/base/code/tree/format'
import { parseTree } from '@term/base/code/tree/parse'

const M1 = '11111111-1111-4111-8111-111111111111'
const S1 = '22222222-2222-4222-8222-222222222222'
const S2 = '33333333-3333-4333-8333-333333333333'

describe('.tree format and parse round-trip', () => {
  it('round-trips a rich record', () => {
    const r = record({
      type: 'word',
      mark: M1,
      label: 'foo',
      fields: {
        term: text('foo'),
        count: integer(5),
        verified: boolean(true),
        lang: ref('99999999-9999-4999-8999-999999999999'),
        tags: set([item(text('a')), item(text('b'))]),
        senses: list([
          item(
            nested(
              record({
                type: 'sense',
                mark: S1,
                fields: { gloss: text('medicinal compound') },
              }),
            ),
            S1,
          ),
          item(
            nested(
              record({
                type: 'sense',
                mark: S2,
                fields: { gloss: text('pharmacy text') },
              }),
            ),
            S2,
          ),
        ]),
      },
    })
    const printed = formatTree(r)
    const back = parseTree(printed)
    expect(canonicalizeRecord(back)).toBe(canonicalizeRecord(r))
    // formatting is stable
    expect(formatTree(back)).toBe(printed)
  })

  it('round-trips multiline text', () => {
    const r = record({
      type: 'word',
      mark: M1,
      fields: { definition: text('line one\nline two') },
    })
    const back = parseTree(formatTree(r))
    expect(back.fields.get('definition')).toEqual(text('line one\nline two'))
  })

  it('parses a hand-written .tree', () => {
    const src = [
      'word foo',
      '  mark <11111111-1111-4111-8111-111111111111>',
      '  term སྨན',
      '  count @integer 42',
    ].join('\n')
    const r = parseTree(src)
    expect(r.type).toBe('word')
    expect(r.mark).toBe(M1)
    expect(r.fields.get('term')).toEqual(text('སྨན'))
    expect(r.fields.get('count')).toEqual(integer(42))
  })
})
