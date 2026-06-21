import { describe, it, expect } from 'vitest'
import {
  parseMark,
  parseMarkHold,
  showMark,
  compareMark,
  markMatch,
  pickBestMark,
  bumpMark,
} from '../code/mark'

describe('parseMark', () => {
  it('parses simple version', () => {
    const mark = parseMark('1.2.3')
    expect(mark).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('parses version with prerelease', () => {
    const mark = parseMark('1.0.0-beta.1')
    expect(mark).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'beta.1',
    })
  })

  it('throws on invalid version', () => {
    expect(() => parseMark('abc')).toThrow('Invalid version')
  })
})

describe('showMark', () => {
  it('shows simple version', () => {
    expect(showMark({ major: 1, minor: 2, patch: 3 })).toBe('1.2.3')
  })

  it('shows version with prerelease', () => {
    expect(
      showMark({ major: 1, minor: 0, patch: 0, prerelease: 'beta.1' }),
    ).toBe('1.0.0-beta.1')
  })
})

describe('compareMark', () => {
  it('compares major versions', () => {
    const a = { major: 2, minor: 0, patch: 0 }
    const b = { major: 1, minor: 0, patch: 0 }
    expect(compareMark(a, b)).toBeGreaterThan(0)
  })

  it('compares minor versions', () => {
    const a = { major: 1, minor: 2, patch: 0 }
    const b = { major: 1, minor: 1, patch: 0 }
    expect(compareMark(a, b)).toBeGreaterThan(0)
  })

  it('compares patch versions', () => {
    const a = { major: 1, minor: 0, patch: 2 }
    const b = { major: 1, minor: 0, patch: 1 }
    expect(compareMark(a, b)).toBeGreaterThan(0)
  })

  it('prerelease sorts before release', () => {
    const a = { major: 1, minor: 0, patch: 0, prerelease: 'beta' }
    const b = { major: 1, minor: 0, patch: 0 }
    expect(compareMark(a, b)).toBeLessThan(0)
  })
})

describe('parseMarkHold', () => {
  it('parses exact version', () => {
    const hold = parseMarkHold('1.2.3')
    expect(hold).toEqual({
      form: 'exact',
      mark: { major: 1, minor: 2, patch: 3 },
    })
  })

  it('parses major wildcard', () => {
    const hold = parseMarkHold('1.x.x')
    expect(hold).toEqual({ form: 'wild', major: 1 })
  })

  it('parses minor wildcard', () => {
    const hold = parseMarkHold('1.2.x')
    expect(hold).toEqual({ form: 'wild', major: 1, minor: 2 })
  })

  it('parses band range', () => {
    const hold = parseMarkHold('1.0.0..2.0.0')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 1, minor: 0, patch: 0 },
      head: { major: 2, minor: 0, patch: 0 },
    })
  })

  it('parses union (test)', () => {
    const hold = parseMarkHold('0.14.x|0.15.x')
    expect(hold.form).toBe('test')
    if (hold.form === 'test') {
      expect(hold.list).toHaveLength(2)
      expect(hold.list[0]).toEqual({ form: 'wild', major: 0, minor: 14 })
      expect(hold.list[1]).toEqual({ form: 'wild', major: 0, minor: 15 })
    }
  })

  it('parses caret constraint', () => {
    const hold = parseMarkHold('^1.2.3')
    expect(hold).toEqual({ form: 'wild', major: 1 })
  })

  it('parses tilde constraint', () => {
    const hold = parseMarkHold('~1.2.3')
    expect(hold).toEqual({ form: 'wild', major: 1, minor: 2 })
  })
})

describe('markMatch', () => {
  it('matches exact version', () => {
    const mark = { major: 1, minor: 2, patch: 3 }
    const hold = parseMarkHold('1.2.3')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('does not match different exact version', () => {
    const mark = { major: 1, minor: 2, patch: 4 }
    const hold = parseMarkHold('1.2.3')
    expect(markMatch(mark, hold)).toBe(false)
  })

  it('matches major wildcard', () => {
    const mark = { major: 1, minor: 5, patch: 3 }
    const hold = parseMarkHold('1.x.x')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('does not match wrong major', () => {
    const mark = { major: 2, minor: 0, patch: 0 }
    const hold = parseMarkHold('1.x.x')
    expect(markMatch(mark, hold)).toBe(false)
  })

  it('matches minor wildcard', () => {
    const mark = { major: 1, minor: 2, patch: 9 }
    const hold = parseMarkHold('1.2.x')
    expect(markMatch(mark, hold)).toBe(true)
  })
})

describe('pickBestMark', () => {
  it('picks highest matching version', () => {
    const versions = [
      { major: 1, minor: 0, patch: 0 },
      { major: 1, minor: 1, patch: 0 },
      { major: 1, minor: 2, patch: 0 },
      { major: 2, minor: 0, patch: 0 },
    ]
    const hold = parseMarkHold('1.x.x')
    const best = pickBestMark({ versions, hold })
    expect(best).toEqual({ major: 1, minor: 2, patch: 0 })
  })

  it('returns undefined when no match', () => {
    const versions = [{ major: 2, minor: 0, patch: 0 }]
    const hold = parseMarkHold('1.x.x')
    const best = pickBestMark({ versions, hold })
    expect(best).toBeUndefined()
  })
})

describe('markMatch (band)', () => {
  it('matches version inside range', () => {
    const mark = { major: 1, minor: 5, patch: 0 }
    const hold = parseMarkHold('1.0.0..2.0.0')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('matches lower bound (inclusive)', () => {
    const mark = { major: 1, minor: 0, patch: 0 }
    const hold = parseMarkHold('1.0.0..2.0.0')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('does not match upper bound (exclusive)', () => {
    const mark = { major: 2, minor: 0, patch: 0 }
    const hold = parseMarkHold('1.0.0..2.0.0')
    expect(markMatch(mark, hold)).toBe(false)
  })

  it('does not match below range', () => {
    const mark = { major: 0, minor: 9, patch: 0 }
    const hold = parseMarkHold('1.0.0..2.0.0')
    expect(markMatch(mark, hold)).toBe(false)
  })
})

describe('markMatch (test/union)', () => {
  it('matches first option', () => {
    const mark = { major: 0, minor: 14, patch: 5 }
    const hold = parseMarkHold('0.14.x|0.15.x')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('matches second option', () => {
    const mark = { major: 0, minor: 15, patch: 0 }
    const hold = parseMarkHold('0.14.x|0.15.x')
    expect(markMatch(mark, hold)).toBe(true)
  })

  it('does not match outside union', () => {
    const mark = { major: 0, minor: 16, patch: 0 }
    const hold = parseMarkHold('0.14.x|0.15.x')
    expect(markMatch(mark, hold)).toBe(false)
  })
})

describe('bumpMark', () => {
  it('bumps major version', () => {
    const mark = { major: 1, minor: 2, patch: 3 }
    const bumped = bumpMark({ mark, level: 1 })
    expect(bumped).toEqual({ major: 2, minor: 0, patch: 0 })
  })

  it('bumps minor version', () => {
    const mark = { major: 1, minor: 2, patch: 3 }
    const bumped = bumpMark({ mark, level: 2 })
    expect(bumped).toEqual({ major: 1, minor: 3, patch: 0 })
  })

  it('bumps patch to next even number', () => {
    const mark = { major: 1, minor: 0, patch: 2 }
    const bumped = bumpMark({ mark, level: 3 })
    expect(bumped.patch % 2).toBe(0)
    expect(bumped.patch).toBeGreaterThan(2)
  })

  it('bumps odd patch to next even', () => {
    const mark = { major: 1, minor: 0, patch: 3 }
    const bumped = bumpMark({ mark, level: 3 })
    expect(bumped).toEqual({ major: 1, minor: 0, patch: 4 })
  })

  it('bumps even patch to next even', () => {
    const mark = { major: 1, minor: 0, patch: 4 }
    const bumped = bumpMark({ mark, level: 3 })
    expect(bumped).toEqual({ major: 1, minor: 0, patch: 6 })
  })
})
