import { describe, it, expect } from 'vitest'
import {
  makeTextDelta,
  applyTextDelta,
  applyVerifiedTextDelta,
  deltaIsWorthwhile,
} from '../code/object/delta'
import { hashObject } from '../code/object/hash'

const idOf = (text: string): string =>
  hashObject({ kind: 'blob', bytes: Buffer.from(text, 'utf8') })

function lines(count: number): string {
  return `${Array.from({ length: count }, (_, i) => `line ${i}`).join('\n')}\n`
}

function delta(base: string, next: string) {
  return makeTextDelta({
    base: { id: idOf(base), text: base },
    next: { id: idOf(next), text: next },
  })
}

describe('makeTextDelta', () => {
  it('reduces a one-line edit to one hunk', () => {
    const base = lines(400)
    const next = base.replace('line 200', 'line 200 CHANGED')

    expect(delta(base, next).hunks).toHaveLength(1)
  })

  it('is far smaller than the file it replaces', () => {
    const base = lines(400)
    const next = base.replace('line 200', 'line 200 CHANGED')
    const encoded = Buffer.byteLength(
      JSON.stringify(delta(base, next).hunks),
    )

    expect(encoded).toBeLessThan(Buffer.byteLength(next) / 10)
  })

  it('names the base it was built against', () => {
    const base = lines(10)
    const next = base.replace('line 5', 'line 5 x')

    expect(delta(base, next).base).toBe(idOf(base))
  })
})

describe('applyTextDelta', () => {
  it('reconstructs the text exactly', () => {
    const base = lines(400)
    const next = base.replace('line 200', 'line 200 CHANGED')

    expect(applyTextDelta({ base, delta: delta(base, next) })).toBe(next)
  })

  it('handles several separated edits', () => {
    const base = lines(400)
    const next = base
      .replace('line 10', 'line 10 a')
      .replace('line 200', 'line 200 b')
      .replace('line 390', 'line 390 c')

    expect(applyTextDelta({ base, delta: delta(base, next) })).toBe(next)
  })

  it('handles an insertion, which shifts every later line', () => {
    const base = lines(50)
    const next = base.replace('line 10\n', 'line 10\nline 10 and a half\n')

    expect(applyTextDelta({ base, delta: delta(base, next) })).toBe(next)
  })

  it('handles a deletion', () => {
    const base = lines(50)
    const next = base.replace('line 25\n', '')

    expect(applyTextDelta({ base, delta: delta(base, next) })).toBe(next)
  })

  it('handles appending to the end', () => {
    const base = lines(20)
    const next = `${base}line 20\n`

    expect(applyTextDelta({ base, delta: delta(base, next) })).toBe(next)
  })
})

describe('applyVerifiedTextDelta', () => {
  it('returns the text when it reconstructs correctly', () => {
    const base = lines(100)
    const next = base.replace('line 50', 'line 50 x')

    expect(
      applyVerifiedTextDelta({ base, delta: delta(base, next) }),
    ).toBe(next)
  })

  it('rejects a delta applied to the wrong base', () => {
    const base = lines(100)
    const next = base.replace('line 50', 'line 50 x')
    const wrong = base.replace('line 0', 'line 0 different')

    expect(() =>
      applyVerifiedTextDelta({ base: wrong, delta: delta(base, next) }),
    ).toThrow(/did not reconstruct/)
  })
})

describe('deltaIsWorthwhile', () => {
  it('accepts a small edit to a large file', () => {
    const base = lines(400)
    const next = base.replace('line 200', 'line 200 CHANGED')

    expect(
      deltaIsWorthwhile({
        delta: delta(base, next),
        nextSize: Buffer.byteLength(next),
      }),
    ).toBe(true)
  })

  it('refuses a tiny file, where the delta costs more than the content', () => {
    const base = 'a\nb\n'
    const next = 'a\nc\n'

    expect(
      deltaIsWorthwhile({
        delta: delta(base, next),
        nextSize: Buffer.byteLength(next),
      }),
    ).toBe(false)
  })

  it('refuses a rewrite, where the delta is the whole file again', () => {
    const base = lines(200)
    const next = `${Array.from({ length: 200 }, (_, i) => `entirely different ${i}`).join('\n')}\n`

    expect(
      deltaIsWorthwhile({
        delta: delta(base, next),
        nextSize: Buffer.byteLength(next),
      }),
    ).toBe(false)
  })
})
