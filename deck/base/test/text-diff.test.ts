import { describe, it, expect } from 'vitest'
import { diffText, diffTokens, tokenize, detokenize } from '@/text/diff'
import { merge3Text, merge3Tokens } from '@/text/merge'

describe('token diff', () => {
  it('produces a minimal edit script that reconstructs the target', () => {
    const a = tokenize('the quick brown fox', 'word')
    const b = tokenize('the slow brown fox', 'word')
    const edits = diffTokens(a, b)
    // reconstruct b from the script
    const rebuilt: Array<string> = []
    for (const e of edits) {
      if (e.tag === 'eq') rebuilt.push(a[e.a]!)
      else if (e.tag === 'ins') rebuilt.push(b[e.b]!)
    }
    expect(detokenize(rebuilt, 'word')).toBe('the slow brown fox')
  })

  it('diffs at word granularity, not whole-value replacement', () => {
    const hunks = diffText('a medicinal compound', 'a medical compound', 'word')
    // the shared words stay equal; only the changed word is del+ins
    const changed = hunks.filter(h => h.tag !== 'eq')
    expect(changed.some(h => h.tag === 'del' && h.text.includes('medicinal'))).toBe(true)
    expect(changed.some(h => h.tag === 'ins' && h.text.includes('medical'))).toBe(true)
    expect(hunks.some(h => h.tag === 'eq' && h.text.includes('compound'))).toBe(true)
  })

  it('handles empty and identical inputs', () => {
    expect(diffText('', '', 'line')).toEqual([])
    expect(diffText('same', 'same', 'char').every(h => h.tag === 'eq')).toBe(true)
  })

  it('diffs lines', () => {
    const hunks = diffText('one\ntwo\nthree', 'one\nTWO\nthree', 'line')
    expect(hunks.some(h => h.tag === 'del' && h.text === 'two')).toBe(true)
    expect(hunks.some(h => h.tag === 'ins' && h.text === 'TWO')).toBe(true)
  })
})

describe('three-way text merge', () => {
  it('merges disjoint word edits inside one string cleanly (better than line merge)', () => {
    const base = 'the quick brown fox jumps'
    const a = 'the slow brown fox jumps' // edit word 2
    const b = 'the quick brown fox leaps' // edit word 5
    const m = merge3Text(base, a, b, 'word')
    expect(m.clean).toBe(true)
    expect(m.text).toBe('the slow brown fox leaps')
  })

  it('conflicts only when the same region is edited differently', () => {
    const base = 'the quick brown fox'
    const a = 'the slow brown fox'
    const b = 'the fast brown fox'
    const m = merge3Text(base, a, b, 'word')
    expect(m.clean).toBe(false)
    expect(m.conflicts).toBe(1)
    expect(m.text).toContain('<<<<<<<')
    expect(m.text).toContain('slow')
    expect(m.text).toContain('fast')
  })

  it('takes an identical edit made on both sides once', () => {
    const base = 'alpha beta gamma'
    const same = 'alpha BETA gamma'
    const m = merge3Text(base, same, same, 'word')
    expect(m.clean).toBe(true)
    expect(m.text).toBe('alpha BETA gamma')
  })

  it('applies an insertion from one side and a deletion from the other', () => {
    const base = 'a b c d e'
    const a = 'a b c d e f' // append f
    const b = 'a c d e' // delete b
    const m = merge3Text(base, a, b, 'word')
    expect(m.clean).toBe(true)
    expect(m.text).toBe('a c d e f')
  })

  it('merges multi-line files region by region', () => {
    const base = 'line1\nline2\nline3\nline4'
    const a = 'line1\nCHANGED2\nline3\nline4'
    const b = 'line1\nline2\nline3\nCHANGED4'
    const m = merge3Text(base, a, b, 'line')
    expect(m.clean).toBe(true)
    expect(m.text).toBe('line1\nCHANGED2\nline3\nCHANGED4')
  })

  it('returns structured regions for programmatic handling', () => {
    const regions = merge3Tokens(
      tokenize('x y z', 'word'),
      tokenize('x Y z', 'word'),
      tokenize('x y Z', 'word'),
    )
    const conflicts = regions.filter(r => 'conflict' in r)
    expect(conflicts.length).toBe(0)
  })
})
