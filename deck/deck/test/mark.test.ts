import { describe, it, expect } from 'vitest'
import {
  parseCode,
  parseCodeHold,
  showCode,
  compareCode,
  codeMatch,
  pickBestCode,
  bumpCode,
} from '../code/code'

describe('parseCode', () => {
  it('parses simple version', () => {
    const code = parseCode('1.2.3')
    expect(code).toEqual({ major: 1, minor: 2, patch: 3 })
  })

  it('parses version with prerelease', () => {
    const code = parseCode('1.0.0-beta.1')
    expect(code).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      prerelease: 'beta.1',
    })
  })

  it('throws on invalid version', () => {
    expect(() => parseCode('abc')).toThrow('Invalid version')
  })
})

describe('showCode', () => {
  it('shows simple version', () => {
    expect(showCode({ major: 1, minor: 2, patch: 3 })).toBe('1.2.3')
  })

  it('shows version with prerelease', () => {
    expect(
      showCode({ major: 1, minor: 0, patch: 0, prerelease: 'beta.1' }),
    ).toBe('1.0.0-beta.1')
  })
})

describe('compareCode', () => {
  it('compares major versions', () => {
    const a = { major: 2, minor: 0, patch: 0 }
    const b = { major: 1, minor: 0, patch: 0 }
    expect(compareCode(a, b)).toBeGreaterThan(0)
  })

  it('compares minor versions', () => {
    const a = { major: 1, minor: 2, patch: 0 }
    const b = { major: 1, minor: 1, patch: 0 }
    expect(compareCode(a, b)).toBeGreaterThan(0)
  })

  it('compares patch versions', () => {
    const a = { major: 1, minor: 0, patch: 2 }
    const b = { major: 1, minor: 0, patch: 1 }
    expect(compareCode(a, b)).toBeGreaterThan(0)
  })

  it('prerelease sorts before release', () => {
    const a = { major: 1, minor: 0, patch: 0, prerelease: 'beta' }
    const b = { major: 1, minor: 0, patch: 0 }
    expect(compareCode(a, b)).toBeLessThan(0)
  })
})

describe('parseCodeHold', () => {
  it('parses exact version', () => {
    const hold = parseCodeHold('1.2.3')
    expect(hold).toEqual({
      form: 'exact',
      code: { major: 1, minor: 2, patch: 3 },
    })
  })

  it('parses major wildcard', () => {
    const hold = parseCodeHold('1.x.x')
    expect(hold).toEqual({ form: 'wild', major: 1 })
  })

  it('parses minor wildcard', () => {
    const hold = parseCodeHold('1.2.x')
    expect(hold).toEqual({ form: 'wild', major: 1, minor: 2 })
  })

  it('parses band range', () => {
    const hold = parseCodeHold('1.0.0..2.0.0')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 1, minor: 0, patch: 0 },
      head: { major: 2, minor: 0, patch: 0 },
    })
  })

  it('parses union (test)', () => {
    const hold = parseCodeHold('0.14.x|0.15.x')
    expect(hold.form).toBe('test')
    if (hold.form === 'test') {
      expect(hold.list).toHaveLength(2)
      expect(hold.list[0]).toEqual({ form: 'wild', major: 0, minor: 14 })
      expect(hold.list[1]).toEqual({ form: 'wild', major: 0, minor: 15 })
    }
  })

  it('parses caret constraint as a precise band', () => {
    // the npm rule: ^1.2.3 allows >=1.2.3 <2.0.0, so the lower bound is the version itself (1.0.0 must NOT match)
    const hold = parseCodeHold('^1.2.3')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 1, minor: 2, patch: 3 },
      head: { major: 2, minor: 0, patch: 0 },
    })
  })

  it('parses leading-zero caret locking the minor', () => {
    // ^0.2.3 locks the left-most non-zero element: >=0.2.3 <0.3.0
    const hold = parseCodeHold('^0.2.3')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 0, minor: 2, patch: 3 },
      head: { major: 0, minor: 3, patch: 0 },
    })
  })

  it('parses double-zero caret locking the patch', () => {
    // ^0.0.3 is exactly >=0.0.3 <0.0.4
    const hold = parseCodeHold('^0.0.3')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 0, minor: 0, patch: 3 },
      head: { major: 0, minor: 0, patch: 4 },
    })
  })

  it('parses tilde constraint as a precise band', () => {
    // the npm rule: ~1.2.3 allows >=1.2.3 <1.3.0 (patch movement within the minor)
    const hold = parseCodeHold('~1.2.3')
    expect(hold).toEqual({
      form: 'band',
      base: { major: 1, minor: 2, patch: 3 },
      head: { major: 1, minor: 3, patch: 0 },
    })
  })

  it('caret band excludes versions below its base', () => {
    expect(
      codeMatch(
        { major: 1, minor: 0, patch: 0 },
        parseCodeHold('^1.2.3'),
      ),
    ).toBe(false)
    expect(
      codeMatch(
        { major: 1, minor: 9, patch: 9 },
        parseCodeHold('^1.2.3'),
      ),
    ).toBe(true)
    expect(
      codeMatch(
        { major: 2, minor: 0, patch: 0 },
        parseCodeHold('^1.2.3'),
      ),
    ).toBe(false)
  })

  it('tilde band stays within the minor', () => {
    expect(
      codeMatch(
        { major: 1, minor: 2, patch: 9 },
        parseCodeHold('~1.2.3'),
      ),
    ).toBe(true)
    expect(
      codeMatch(
        { major: 1, minor: 3, patch: 0 },
        parseCodeHold('~1.2.3'),
      ),
    ).toBe(false)
  })
})

describe('codeMatch', () => {
  it('matches exact version', () => {
    const code = { major: 1, minor: 2, patch: 3 }
    const hold = parseCodeHold('1.2.3')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('does not match different exact version', () => {
    const code = { major: 1, minor: 2, patch: 4 }
    const hold = parseCodeHold('1.2.3')
    expect(codeMatch(code, hold)).toBe(false)
  })

  it('matches major wildcard', () => {
    const code = { major: 1, minor: 5, patch: 3 }
    const hold = parseCodeHold('1.x.x')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('does not match wrong major', () => {
    const code = { major: 2, minor: 0, patch: 0 }
    const hold = parseCodeHold('1.x.x')
    expect(codeMatch(code, hold)).toBe(false)
  })

  it('matches minor wildcard', () => {
    const code = { major: 1, minor: 2, patch: 9 }
    const hold = parseCodeHold('1.2.x')
    expect(codeMatch(code, hold)).toBe(true)
  })
})

describe('pickBestCode', () => {
  it('picks highest matching version', () => {
    const versions = [
      { major: 1, minor: 0, patch: 0 },
      { major: 1, minor: 1, patch: 0 },
      { major: 1, minor: 2, patch: 0 },
      { major: 2, minor: 0, patch: 0 },
    ]
    const hold = parseCodeHold('1.x.x')
    const best = pickBestCode({ versions, hold })
    expect(best).toEqual({ major: 1, minor: 2, patch: 0 })
  })

  it('returns undefined when no match', () => {
    const versions = [{ major: 2, minor: 0, patch: 0 }]
    const hold = parseCodeHold('1.x.x')
    const best = pickBestCode({ versions, hold })
    expect(best).toBeUndefined()
  })
})

describe('codeMatch (band)', () => {
  it('matches version inside range', () => {
    const code = { major: 1, minor: 5, patch: 0 }
    const hold = parseCodeHold('1.0.0..2.0.0')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('matches lower bound (inclusive)', () => {
    const code = { major: 1, minor: 0, patch: 0 }
    const hold = parseCodeHold('1.0.0..2.0.0')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('does not match upper bound (exclusive)', () => {
    const code = { major: 2, minor: 0, patch: 0 }
    const hold = parseCodeHold('1.0.0..2.0.0')
    expect(codeMatch(code, hold)).toBe(false)
  })

  it('does not match below range', () => {
    const code = { major: 0, minor: 9, patch: 0 }
    const hold = parseCodeHold('1.0.0..2.0.0')
    expect(codeMatch(code, hold)).toBe(false)
  })
})

describe('codeMatch (test/union)', () => {
  it('matches first option', () => {
    const code = { major: 0, minor: 14, patch: 5 }
    const hold = parseCodeHold('0.14.x|0.15.x')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('matches second option', () => {
    const code = { major: 0, minor: 15, patch: 0 }
    const hold = parseCodeHold('0.14.x|0.15.x')
    expect(codeMatch(code, hold)).toBe(true)
  })

  it('does not match outside union', () => {
    const code = { major: 0, minor: 16, patch: 0 }
    const hold = parseCodeHold('0.14.x|0.15.x')
    expect(codeMatch(code, hold)).toBe(false)
  })
})

describe('bumpCode', () => {
  it('bumps major version', () => {
    const code = { major: 1, minor: 2, patch: 3 }
    const bumped = bumpCode({ code, level: 1 })
    expect(bumped).toEqual({ major: 2, minor: 0, patch: 0 })
  })

  it('bumps minor version', () => {
    const code = { major: 1, minor: 2, patch: 3 }
    const bumped = bumpCode({ code, level: 2 })
    expect(bumped).toEqual({ major: 1, minor: 3, patch: 0 })
  })

  it('bumps patch to next even number', () => {
    const code = { major: 1, minor: 0, patch: 2 }
    const bumped = bumpCode({ code, level: 3 })
    expect(bumped.patch % 2).toBe(0)
    expect(bumped.patch).toBeGreaterThan(2)
  })

  it('bumps odd patch to next even', () => {
    const code = { major: 1, minor: 0, patch: 3 }
    const bumped = bumpCode({ code, level: 3 })
    expect(bumped).toEqual({ major: 1, minor: 0, patch: 4 })
  })

  it('bumps even patch to next even', () => {
    const code = { major: 1, minor: 0, patch: 4 }
    const bumped = bumpCode({ code, level: 3 })
    expect(bumped).toEqual({ major: 1, minor: 0, patch: 6 })
  })
})
