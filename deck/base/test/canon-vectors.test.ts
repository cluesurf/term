// The four hash-breaking ambiguities, pinned.
//
// design/canonical-serialization-rigor.md singles out four areas where an unstated rule
// makes two implementations disagree on the hash of identical data: unicode normalization,
// locale-independent collation, date and decimal representation, and null versus missing.
// All four were IMPLEMENTED and none was tested, which is the state where a refactor can
// change every hash in the corpus and no test notices.
//
// Each case here is a vector: an input, and the property its bytes must have. They are
// asserted as relationships (these two encode the same, those two do not) rather than as
// literal digests, so the suite pins the RULES rather than one build's output, and a
// deliberate format change fails on the rule it broke rather than on 40 opaque hashes.
//
// See note/library/base/project/base-format.json.

import { describe, it, expect } from 'vitest'
import {
  canonicalBytes,
  canonicalValueBytes,
  bytesToBase16,
  normalizeDecimal,
} from '@term/base/code/canon/canonicalize'
import { hashRecord } from '@term/base/code/canon/hash'
import {
  FORMAT_VERSION,
  READABLE_FORMATS,
  settleFormat,
  FORMAT_REF,
} from '@term/base/code/canon/format'
import { CANONICAL_FORM_VERSION } from '@term/base/code/canon/cbor'
import { MemoryRefStore } from '@term/base/code/store/ref-store'
import { text, integer, decimal, date } from '@term/base/code/base/make'
import type { RecordNode, Value } from '@term/base/code/base/type'

const MARK = '0195f0e6-1c4a-7bd3-9f2e-000000000001'

function record(fields: Array<[string, Value]>): RecordNode {
  return { mark: MARK, type: 'word', fields: new Map(fields) }
}

function hex(node: RecordNode): string {
  return bytesToBase16(canonicalBytes(node))
}

function collection(
  order: 'set' | 'map' | 'list',
  items: Array<{ key?: string; value: Value }>,
): Value {
  return { kind: 'collection', order, items } as Value
}

describe('unicode normalization', () => {
  // The single most likely ambiguity to fire in a dictionary, because composed and
  // decomposed spellings both occur naturally in real language data and look identical.
  it('encodes composed and decomposed spellings of a value identically', () => {
    const composed = record([['text', text('é')]]) // é
    const decomposed = record([['text', text('é')]]) // e + combining acute

    expect(hex(composed)).toBe(hex(decomposed))
    expect(hashRecord(composed)).toBe(hashRecord(decomposed))
  })

  it('encodes composed and decomposed spellings of a FIELD NAME identically', () => {
    const composed = record([['café', text('x')]])
    const decomposed = record([['café', text('x')]])

    expect(hex(composed)).toBe(hex(decomposed))
  })

  it('refuses two field names that collide only after normalization', () => {
    // Encoding them would produce a map with two identical keys, which the decoder's
    // canonical-order guard rejects, making a record that stored fine unreadable forever.
    // Caught at encode time instead, so the collision never reaches storage.
    expect(() =>
      canonicalBytes(record([
        ['café', text('one')],
        ['café', text('two')],
      ])),
    ).toThrow(/duplicate map key/)
  })

  it('does not conflate genuinely different strings', () => {
    expect(hex(record([['text', text('a')]]))).not.toBe(
      hex(record([['text', text('A')]])),
    )
  })
})

describe('locale-independent collation', () => {
  it('orders a set by canonical bytes, so member order never changes the encoding', () => {
    const forward = collection('set', [
      { value: text('a') },
      { value: text('b') },
      { value: text('c') },
    ])
    const backward = collection('set', [
      { value: text('c') },
      { value: text('b') },
      { value: text('a') },
    ])

    expect(bytesToBase16(canonicalValueBytes(forward))).toBe(
      bytesToBase16(canonicalValueBytes(backward)),
    )
  })

  it('orders a map by its keys, independent of the order given', () => {
    const forward = collection('map', [
      { key: 'a', value: text('1') },
      { key: 'b', value: text('2') },
    ])
    const backward = collection('map', [
      { key: 'b', value: text('2') },
      { key: 'a', value: text('1') },
    ])

    expect(bytesToBase16(canonicalValueBytes(forward))).toBe(
      bytesToBase16(canonicalValueBytes(backward)),
    )
  })

  it('orders map keys by UTF-8 bytes, not by UTF-16 code units', () => {
    // The regression this file was written for. JavaScript's `<` compares UTF-16 code
    // units, so a character above the BMP (a surrogate pair, leading 0xD8xx) sorts BEFORE
    // one in the 0xE000..0xFFFF range, while their UTF-8 bytes sort the other way. A map
    // collection used to sort by `<` while a record's map keys sorted by UTF-8 bytes, so
    // the same two keys ordered differently in the two places.
    const emoji = '\u{1F600}' // U+1F600, four UTF-8 bytes starting 0xF0
    const bmp = '�' // U+FFFD, three UTF-8 bytes starting 0xEF

    // UTF-16: the surrogate pair sorts first. UTF-8: the three-byte form sorts first.
    expect(emoji < bmp).toBe(true)

    const one = collection('map', [
      { key: emoji, value: text('1') },
      { key: bmp, value: text('2') },
    ])
    const two = collection('map', [
      { key: bmp, value: text('2') },
      { key: emoji, value: text('1') },
    ])

    // whichever order it picks, it must pick the SAME one from either input
    expect(bytesToBase16(canonicalValueBytes(one))).toBe(
      bytesToBase16(canonicalValueBytes(two)),
    )

    // and it must be UTF-8 order, so the three-byte key comes first
    const bytes = canonicalValueBytes(one)
    const encoder = new TextEncoder()
    const first = bytesToBase16(encoder.encode(bmp))
    const second = bytesToBase16(encoder.encode(emoji))

    expect(bytesToBase16(bytes).indexOf(first)).toBeLessThan(
      bytesToBase16(bytes).indexOf(second),
    )
  })

  it('normalizes map keys before ordering them', () => {
    const composed = collection('map', [{ key: 'café', value: text('1') }])
    const decomposed = collection('map', [{ key: 'café', value: text('1') }])

    expect(bytesToBase16(canonicalValueBytes(composed))).toBe(
      bytesToBase16(canonicalValueBytes(decomposed)),
    )
  })

  it('keeps a list in the order it was given, because a list is ordered', () => {
    const forward = collection('list', [{ value: text('a') }, { value: text('b') }])
    const backward = collection('list', [{ value: text('b') }, { value: text('a') }])

    expect(bytesToBase16(canonicalValueBytes(forward))).not.toBe(
      bytesToBase16(canonicalValueBytes(backward)),
    )
  })
})

describe('decimals', () => {
  it('preserves significant digits, so 1.50 is not 1.5', () => {
    // A decimal carries its precision: "1.50" states two decimal places were measured.
    // Collapsing it to 1.5 would silently discard that, and a float round trip would do it
    // invisibly, which is why floats are forbidden outright.
    expect(normalizeDecimal('1.50')).not.toBe(normalizeDecimal('1.5'))
  })

  it('encodes the same value written two ways identically', () => {
    expect(normalizeDecimal('1.5')).toBe(normalizeDecimal('+1.5'))
  })

  it('distinguishes a decimal from an integer of the same value', () => {
    expect(bytesToBase16(canonicalValueBytes(decimal('1')))).not.toBe(
      bytesToBase16(canonicalValueBytes(integer(1))),
    )
  })

  it('handles a mantissa beyond what a double can hold exactly', () => {
    // 2^53 + 1. A float-based encoder loses this, and the loss is silent.
    const big = '9007199254740993'

    expect(normalizeDecimal(big)).toContain('9007199254740993')
  })

  it('distinguishes zero written at different precisions', () => {
    expect(normalizeDecimal('0.00')).not.toBe(normalizeDecimal('0'))
  })
})

describe('dates, null and missing', () => {
  it('distinguishes a date from the text of the same date', () => {
    // Without the tag these are the same bytes, and a reader would have to consult the
    // form to tell a timestamp from a string that looks like one.
    expect(bytesToBase16(canonicalValueBytes(date('2026-08-29')))).not.toBe(
      bytesToBase16(canonicalValueBytes(text('2026-08-29'))),
    )
  })

  it('distinguishes an explicit null from a missing field', () => {
    // The pair most likely to be encoded identically by a second implementation, because
    // most languages collapse them. "the field is absent" and "the field is known to have
    // no value" are different assertions, and a dictionary needs both.
    const present = record([['text', text('x')], ['note', { kind: 'null' } as Value]])
    const missing = record([['text', text('x')]])

    expect(hex(present)).not.toBe(hex(missing))
  })

  it('distinguishes a null from the empty string', () => {
    expect(bytesToBase16(canonicalValueBytes({ kind: 'null' } as Value))).not.toBe(
      bytesToBase16(canonicalValueBytes(text(''))),
    )
  })

  it('does not depend on the order fields were added in', () => {
    const one = record([['a', text('1')], ['b', text('2')]])
    const two = record([['b', text('2')], ['a', text('1')]])

    expect(hex(one)).toBe(hex(two))
  })
})

describe('the canonical-form version', () => {
  it('names the encoder version it describes, so the two cannot drift', () => {
    expect(FORMAT_VERSION).toBe(`base/${CANONICAL_FORM_VERSION}`)
  })

  it('claims an unversioned repository rather than refusing it', () => {
    // An existing repository predates the ref. `base/1` is the only form ever written, so
    // claiming records what is already true instead of asserting something new.
    const refs = new MemoryRefStore()
    const settled = settleFormat(refs)

    expect(settled).toEqual({ ok: true, version: FORMAT_VERSION, claimed: true })
    expect(refs.get(FORMAT_REF)).toBe(FORMAT_VERSION)
  })

  it('proceeds on a repository already at this version, without reclaiming', () => {
    const refs = new MemoryRefStore()
    refs.compareAndSwap(FORMAT_REF, undefined, FORMAT_VERSION)

    expect(settleFormat(refs)).toEqual({
      ok: true,
      version: FORMAT_VERSION,
      claimed: false,
    })
  })

  it('refuses a repository written under a form this build cannot read', () => {
    // The whole point. Without it, an old reader computes different hashes for the same
    // records and reports corruption, and a new reader writes chunks the old one cannot
    // address. Neither would mention versions, because neither would know they exist.
    const refs = new MemoryRefStore()
    refs.compareAndSwap(FORMAT_REF, undefined, 'base/99')

    expect(settleFormat(refs)).toEqual({
      ok: false,
      version: 'base/99',
      reason: 'unreadable',
    })
  })

  it('lists the version it writes among the versions it reads', () => {
    expect(READABLE_FORMATS.has(FORMAT_VERSION)).toBe(true)
  })
})
