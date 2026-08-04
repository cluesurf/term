import { describe, it, expect } from 'vitest'
import { record, text, integer, decimal, list, set, item } from '@term/base/code/base/make'
import {
  canonicalizeRecord,
  normalizeDecimal,
} from '@term/base/code/canon/canonicalize'
import { hashRecord } from '@term/base/code/canon/hash'
import { isMark, mintMark, normalizeMark } from '@term/base/code/base/mark'

describe('canonicalization', () => {
  it('is independent of field insertion order', () => {
    const a = record({
      type: 'word',
      mark: '4f9a2c10-8b3e-4c1a-9f22-7d6e0a1b2c3d',
      fields: { term: text('foo'), lang: text('en') },
    })
    const b = record({
      type: 'word',
      mark: '4f9a2c10-8b3e-4c1a-9f22-7d6e0a1b2c3d',
      fields: { lang: text('en'), term: text('foo') },
    })
    expect(canonicalizeRecord(a)).toBe(canonicalizeRecord(b))
    expect(hashRecord(a)).toBe(hashRecord(b))
  })

  it('distinguishes different values', () => {
    const a = record({ type: 'word', fields: { term: text('foo') } })
    const b = record({ type: 'word', fields: { term: text('bar') } })
    expect(hashRecord(a)).not.toBe(hashRecord(b))
  })

  it('orders an unordered set canonically', () => {
    const a = record({
      type: 'word',
      fields: { tags: set([item(text('b')), item(text('a'))]) },
    })
    const b = record({
      type: 'word',
      fields: { tags: set([item(text('a')), item(text('b'))]) },
    })
    expect(hashRecord(a)).toBe(hashRecord(b))
  })

  it('keeps an ordered list order-sensitive', () => {
    const a = record({
      type: 'word',
      fields: { xs: list([item(text('a')), item(text('b'))]) },
    })
    const b = record({
      type: 'word',
      fields: { xs: list([item(text('b')), item(text('a'))]) },
    })
    expect(hashRecord(a)).not.toBe(hashRecord(b))
  })

  it('distinguishes integer 1 from text "1" from decimal 1', () => {
    const asInt = record({ type: 'n', fields: { v: integer(1) } })
    const asText = record({ type: 'n', fields: { v: text('1') } })
    const asDec = record({ type: 'n', fields: { v: decimal('1') } })
    const hashes = new Set([
      hashRecord(asInt),
      hashRecord(asText),
      hashRecord(asDec),
    ])
    expect(hashes.size).toBe(3)
  })
})

describe('normalizeDecimal', () => {
  // Leading zeros are pure encoding and are stripped. TRAILING zeros are
  // significant and are preserved, because in a knowledge database "5.00" and
  // "5" say different things about measurement precision.
  it('strips leading zeros and preserves trailing ones', () => {
    expect(normalizeDecimal('01.2')).toBe('1.2')
    expect(normalizeDecimal('+1.2')).toBe('1.2')
    expect(normalizeDecimal('100')).toBe('100')
    expect(normalizeDecimal('1.20')).toBe('1.20')
    expect(normalizeDecimal('5.00')).toBe('5.00')
    expect(normalizeDecimal('0.98')).toBe('0.98')
  })

  it('drops the sign on zero but keeps its scale', () => {
    expect(normalizeDecimal('-0.0')).toBe('0.0')
    expect(normalizeDecimal('-0')).toBe('0')
  })

  it('gives a different hash to a differently-scaled decimal', () => {
    const scaled = record({ type: 'w', fields: { n: decimal('5.00') } })
    const plain = record({ type: 'w', fields: { n: decimal('5') } })
    expect(hashRecord(scaled)).not.toBe(hashRecord(plain))
  })
})

describe('mark', () => {
  it('mints a valid uuid v4', () => {
    const m = mintMark()
    expect(isMark(m)).toBe(true)
  })

  it('rejects non-uuid and normalizes case', () => {
    expect(isMark('not-a-uuid')).toBe(false)
    expect(
      normalizeMark('4F9A2C10-8B3E-4C1A-9F22-7D6E0A1B2C3D'),
    ).toBe('4f9a2c10-8b3e-4c1a-9f22-7d6e0a1b2c3d')
  })
})
