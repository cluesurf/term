import { describe, it, expect } from 'vitest'
import { text, integer, decimal, ref, boolean, nul } from '@term/base/code/base/make'
import { diffValues } from '@term/base/code/diff/value-diff'

describe('leaf value diff', () => {
  it('diffs a changed string field at word granularity', () => {
    const d = diffValues(text('a medicinal compound'), text('a medical compound'))
    expect(d.kind).toBe('text')
    if (d.kind === 'text') {
      expect(d.hunks.some(h => h.tag === 'del' && h.text.includes('medicinal'))).toBe(true)
      expect(d.hunks.some(h => h.tag === 'ins' && h.text.includes('medical'))).toBe(true)
      expect(d.hunks.some(h => h.tag === 'eq' && h.text.includes('compound'))).toBe(true)
    }
  })

  it('reports a number as an atomic typed change, not a digit diff', () => {
    const d = diffValues(integer(3), integer(15))
    expect(d).toEqual({ kind: 'number', before: '3', after: '15' })
    const dec = diffValues(decimal('1.5'), decimal('2.25'))
    expect(dec).toEqual({ kind: 'number', before: '1.5', after: '2.25' })
  })

  it('treats within-kind reference and boolean changes as atomic', () => {
    const refA = '11111111-1111-4111-8111-111111111111'
    const refB = '22222222-2222-4222-8222-222222222222'
    expect(diffValues(ref(refA), ref(refB)).kind).toBe('atomic')
    expect(diffValues(boolean(true), boolean(false)).kind).toBe('atomic')
  })

  it('flags an accidental type change loudly as a retype', () => {
    // a number that became a string
    const d = diffValues(integer(7), text('7'))
    expect(d).toEqual({ kind: 'retype', from: 'integer', to: 'text', before: integer(7), after: text('7') })
    // a string that became a number, and a numeric-kind change
    expect(diffValues(text('7'), integer(7)).kind).toBe('retype')
    expect(diffValues(integer(3), decimal('3')).kind).toBe('retype')
  })

  it('treats a set or clear (null on one side) as atomic, not a retype', () => {
    expect(diffValues(nul(), text('x')).kind).toBe('atomic')
    expect(diffValues(integer(1), nul()).kind).toBe('atomic')
  })

  it('reports equal values as equal', () => {
    expect(diffValues(text('same'), text('same'))).toEqual({ kind: 'equal' })
    expect(diffValues(integer(5), integer(5))).toEqual({ kind: 'equal' })
  })
})
