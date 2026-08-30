// A plain JavaScript value as a base value.
//
// The seam every importer needs: data arrives as JSON, as a database row, or as a parsed
// file, and all of it is ordinary JS. Written once so two importers cannot disagree about
// `null` or about a big integer, because that disagreement shows up as a field present in
// one path and absent in the other, long after either was written.

import { describe, it, expect } from 'vitest'
import { valueOf } from '@term/base/code/base/make'

describe('converting a JavaScript value', () => {
  it('takes the scalars', () => {
    expect(valueOf('hello')).toEqual({ kind: 'text', value: 'hello' })
    expect(valueOf(true)).toEqual({ kind: 'boolean', value: true })
    expect(valueOf(7)).toEqual({ kind: 'integer', value: 7n })
    expect(valueOf(7n)).toEqual({ kind: 'integer', value: 7n })
    expect(valueOf(1.5)).toEqual({ kind: 'decimal', value: '1.5' })
  })

  it('takes a Date as an ISO date', () => {
    expect(valueOf(new Date('2026-08-30T12:00:00.000Z'))).toEqual({
      kind: 'date',
      value: '2026-08-30T12:00:00.000Z',
    })
  })

  it('treats null and undefined as ABSENCE, not as a stored null', () => {
    // A record with no `gloss` and a record with an empty `gloss` are different facts.
    // Collapsing them makes a missing column indistinguishable from a blank one after a
    // round trip, and the caller is the one that knows which it meant.
    expect(valueOf(null)).toBeUndefined()
    expect(valueOf(undefined)).toBeUndefined()
  })

  it('refuses NaN and the infinities rather than storing them', () => {
    // No canonical form and no column type. Refusing here keeps them out of the store
    // instead of out of a later and much more confusing error.
    expect(valueOf(Number.NaN)).toBeUndefined()
    expect(valueOf(Number.POSITIVE_INFINITY)).toBeUndefined()
  })

  it('keeps an integer too large for a double as decimal rather than losing it', () => {
    // The case only arises from a source that already lost precision, so the digits are
    // preserved as text and the caller can see what arrived.
    const big = valueOf(2 ** 53 + 2)

    expect(big?.kind).toBe('decimal')
  })

  it('takes an array as a list, recursing', () => {
    expect(valueOf(['a', 'b'])).toEqual({
      kind: 'collection',
      order: 'list',
      items: [
        { value: { kind: 'text', value: 'a' } },
        { value: { kind: 'text', value: 'b' } },
      ],
    })
  })

  it('keeps a list the length it was, writing an empty element as an explicit null', () => {
    // Position is part of what a list means, so a null element cannot shorten it.
    const value = valueOf(['a', null, 'c'])

    expect(value?.kind).toBe('collection')
    expect(value?.kind === 'collection' && value.items).toHaveLength(3)
    expect(value?.kind === 'collection' && value.items[1]?.value).toEqual({
      kind: 'null',
    })
  })

  it('takes a nested object as a nested record, dropping its empty fields', () => {
    const value = valueOf({ a: 1, b: null })

    expect(value?.kind).toBe('record')
    expect(
      value?.kind === 'record' && [...value.record.fields.keys()],
    ).toEqual(['a'])
  })

  it('refuses what is not data', () => {
    expect(valueOf(() => 1)).toBeUndefined()
    expect(valueOf(Symbol('x'))).toBeUndefined()
  })
})
