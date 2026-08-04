import { describe, it, expect } from 'vitest'
import {
  record,
  text,
  integer,
  decimal,
  boolean,
  nul,
  ref,
  blob,
  date,
  list,
  set,
  item,
} from '@/base/make'
import {
  canonicalBytes,
  canonicalValueBytes,
  bytesToBase16,
  base16ToBytes,
  parseDecimal,
  formatDecimal,
} from '@/canon/canonicalize'
import { decodeRecordBytes, decodeValueBytes } from '@/canon/decode'
import {
  ByteWriter,
  writeHead,
  decodeOne,
  TAG_REF,
} from '@/canon/cbor'
import {
  markToBytes,
  bytesToMark,
  bytesToToneMark,
  toToneMark,
  toHexMark,
  MARK_BYTE_LENGTH,
} from '@/canon/mark'

// The canonical form is the only encoding whose exact bytes are load bearing.
// These tests pin the rules that make one value produce one byte sequence, which
// is what a second implementation would have to agree with.
//
// See note/library/base/20-serialization-and-wire-format.md.

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'

describe('deterministic encoding', () => {
  it('is independent of field insertion order', () => {
    const one = record({
      type: 'word',
      fields: { term: text('a'), gloss: text('b') },
    })
    const two = record({
      type: 'word',
      fields: { gloss: text('b'), term: text('a') },
    })
    expect(bytesToBase16(canonicalBytes(one))).toBe(
      bytesToBase16(canonicalBytes(two)),
    )
  })

  it('sorts map keys bytewise, not length-first', () => {
    // "z" is one byte and sorts AFTER "aa" bytewise, but BEFORE it length-first.
    // Bytewise is the decided rule, so "aa" must come first in the output.
    const node = record({
      type: 'w',
      fields: { z: text('1'), aa: text('2') },
    })
    const hex = bytesToBase16(canonicalBytes(node))
    const aaAt = hex.indexOf('626161') // text(2) "aa"
    const zAt = hex.indexOf('617a') // text(1) "z"
    expect(aaAt).toBeGreaterThan(-1)
    expect(zAt).toBeGreaterThan(-1)
    expect(aaAt).toBeLessThan(zAt)
  })

  it('uses the smallest head that fits', () => {
    const small = new ByteWriter()
    writeHead(small, 0, 23n)
    expect(small.done().length).toBe(1)

    const oneByte = new ByteWriter()
    writeHead(oneByte, 0, 24n)
    expect(oneByte.done().length).toBe(2)

    const twoByte = new ByteWriter()
    writeHead(twoByte, 0, 256n)
    expect(twoByte.done().length).toBe(3)
  })

  it('round-trips a record through canonical bytes', () => {
    const node = record({
      type: 'word',
      mark: A,
      label: 'སྨན',
      fields: {
        term: text('medicine'),
        count: integer(42n),
        weight: decimal('0.98'),
        active: boolean(true),
        missing: nul(),
        language: ref(B),
        audio: blob('sha256:abcdef'),
        seen: date('2026-07-27'),
        senses: list([item(text('one')), item(text('two'))]),
      },
    })
    const decoded = decodeRecordBytes(canonicalBytes(node))
    expect(bytesToBase16(canonicalBytes(decoded))).toBe(
      bytesToBase16(canonicalBytes(node)),
    )
    expect(decoded.mark).toBe(A)
    expect(decoded.label).toBe('སྨན')
    expect(decoded.fields.get('language')).toEqual(ref(B))
  })

  it('orders an unordered set by canonical bytes', () => {
    const one = set([item(text('b')), item(text('a'))])
    const two = set([item(text('a')), item(text('b'))])
    expect(bytesToBase16(canonicalValueBytes(one))).toBe(
      bytesToBase16(canonicalValueBytes(two)),
    )
  })

  it('keeps an ordered list order-sensitive', () => {
    const one = list([item(text('a')), item(text('b'))])
    const two = list([item(text('b')), item(text('a'))])
    expect(bytesToBase16(canonicalValueBytes(one))).not.toBe(
      bytesToBase16(canonicalValueBytes(two)),
    )
  })

  it('normalizes text to NFC before encoding', () => {
    // the same grapheme composed and decomposed must produce one encoding
    const composed = text('é') // é
    const decomposed = text('é') // e + combining acute
    expect(bytesToBase16(canonicalValueBytes(composed))).toBe(
      bytesToBase16(canonicalValueBytes(decomposed)),
    )
  })
})

describe('rejections', () => {
  it('rejects a float', () => {
    // major 7, additional info 26 is a 32-bit float
    const bytes = Uint8Array.from([0xfa, 0x00, 0x00, 0x00, 0x00])
    expect(() => decodeOne(bytes)).toThrow(/floating point/)
  })

  it('rejects an indefinite-length item', () => {
    // major 2, additional info 31
    expect(() => decodeOne(Uint8Array.from([0x5f, 0xff]))).toThrow(
      /indefinite-length/,
    )
  })

  it('rejects a non-minimal integer head', () => {
    // 0 written in the 1-extra-byte form instead of inline
    expect(() => decodeOne(Uint8Array.from([0x18, 0x00]))).toThrow(
      /non-minimal/,
    )
  })

  it('rejects trailing bytes', () => {
    expect(() => decodeOne(Uint8Array.from([0x01, 0x01]))).toThrow(
      /trailing bytes/,
    )
  })

  it('rejects map keys that are out of canonical order', () => {
    // a 2-entry map with keys "b" then "a", which is the wrong order
    const bytes = Uint8Array.from([
      0xa2, 0x61, 0x62, 0x01, 0x61, 0x61, 0x02,
    ])
    expect(() => decodeOne(bytes)).toThrow(/out of canonical order/)
  })

  it('rejects a non-text map key', () => {
    // a 1-entry map keyed by the integer 1
    expect(() => decodeOne(Uint8Array.from([0xa1, 0x01, 0x01]))).toThrow(
      /must be text/,
    )
  })

  it('rejects a malformed mark', () => {
    expect(() => markToBytes('a')).toThrow(/32 characters/)
    expect(() => markToBytes('!'.repeat(32))).toThrow(/alphabet/)
  })
})

describe('marks', () => {
  it('encodes to exactly 16 bytes', () => {
    expect(markToBytes(A).length).toBe(MARK_BYTE_LENGTH)
  })

  it('round-trips hex unchanged, so one identity is one key', () => {
    expect(bytesToMark(markToBytes(A))).toBe(A)
  })

  it('accepts the tone alphabet and agrees with hex', () => {
    const tone = toToneMark(A)
    expect(tone).toMatch(/^[mndbtkhsfvzxcwlr]{8}(-[mndbtkhsfvzxcwlr]{8}){3}$/)
    expect(markToBytes(tone)).toEqual(markToBytes(A))
    expect(toHexMark(tone)).toBe(A)
  })

  it('renders the tone form dashed 8-8-8-8', () => {
    const tone = bytesToToneMark(markToBytes(A))
    expect(tone.length).toBe(35)
    expect(tone.split('-').map(g => g.length)).toEqual([8, 8, 8, 8])
  })

  it('costs less than its text form', () => {
    const asValue = canonicalValueBytes(ref(A))
    // one tag plus a 16-byte string head plus the payload, against 37 bytes of
    // quoted tone code in JSON
    expect(asValue.length).toBeLessThan(`"${toToneMark(A)}"`.length)
  })

  it('tags a reference so it is distinguishable without the form', () => {
    const bytes = canonicalValueBytes(ref(A))
    const decoded = decodeOne(bytes)
    expect(decoded.kind).toBe('tag')
    if (decoded.kind === 'tag') {
      expect(decoded.tag).toBe(TAG_REF)
    }
  })

  it('leaves an identity mark untagged', () => {
    const node = record({ type: 'w', mark: A, fields: {} })
    const decoded = decodeOne(canonicalBytes(node))
    expect(decoded.kind).toBe('map')
    if (decoded.kind === 'map') {
      const markEntry = decoded.value.find(([key]) => key === 'mark')
      expect(markEntry?.[1].kind).toBe('bytes')
    }
  })
})

describe('decimals', () => {
  it('keeps trailing zeros distinct', () => {
    expect(parseDecimal('5.00')).toEqual({ exponent: -2, mantissa: 500n })
    expect(parseDecimal('5')).toEqual({ exponent: 0, mantissa: 5n })
    expect(bytesToBase16(canonicalValueBytes(decimal('5.00')))).not.toBe(
      bytesToBase16(canonicalValueBytes(decimal('5'))),
    )
  })

  it('round-trips exactly', () => {
    for (const value of ['0.98', '5.00', '5', '-1.20', '100', '0.0']) {
      expect(formatDecimal(parseDecimal(value))).toBe(value)
      expect(decodeValueBytes(canonicalValueBytes(decimal(value)))).toEqual(
        decimal(value),
      )
    }
  })

  it('carries an arbitrary-precision mantissa', () => {
    const huge = `${'9'.repeat(40)}.${'1'.repeat(20)}`
    expect(formatDecimal(parseDecimal(huge))).toBe(huge)
  })
})

describe('integers', () => {
  it('round-trips across the 64-bit boundary into bignums', () => {
    for (const value of [
      0n,
      23n,
      24n,
      255n,
      65535n,
      2n ** 63n,
      2n ** 64n - 1n,
      2n ** 200n,
      -1n,
      -(2n ** 64n),
      -(2n ** 200n),
    ]) {
      expect(decodeValueBytes(canonicalValueBytes(integer(value)))).toEqual(
        integer(value),
      )
    }
  })
})

describe('base16 view', () => {
  it('round-trips bytes losslessly', () => {
    const bytes = Uint8Array.from([0, 1, 15, 16, 127, 128, 255])
    expect(base16ToBytes(bytesToBase16(bytes))).toEqual(bytes)
  })
})
