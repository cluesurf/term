import type { CollectionKind, Item, RecordNode, Value } from '@term/base/code/base/type'
import {
  ByteWriter,
  TAG_DATE,
  TAG_DECIMAL,
  TAG_REF,
  TAG_BLOB,
  compareBytes,
  writeArrayHead,
  writeBoolean,
  writeBytes,
  writeInteger,
  writeMap,
  writeNull,
  writeTag,
  writeText,
} from '@term/base/code/canon/cbor'
import { markToBytes } from '@term/base/code/canon/mark'

// Canonical serialization. The same meaning always produces the same bytes, so
// hashing, dedup, sync, and citeable releases are deterministic, and equivalent
// records (same fields, different order) serialize identically.
//
// The canonical form is DAG-CBOR. `canonicalBytes` is the real thing, and the
// hash is taken over it. `canonicalizeRecord` returns the same bytes rendered
// as base16 text, which is what the string-keyed store and every equality
// comparison in the codebase use. The text is a lossless view of the bytes, so
// comparing the text is exactly as valid as comparing the bytes.
//
// See note/library/base/03-canonical-serialization.md and
// note/library/base/20-serialization-and-wire-format.md.

// ---------------------------------------------------------------------------
// Decimals
// ---------------------------------------------------------------------------

// A decimal as an exact exponent and mantissa, which is what CBOR tag 4 holds.
// Trailing zeros are SIGNIFICANT and preserved: "5.00" and "5" are different
// values, because in a knowledge database they say different things about
// measurement precision. Leading zeros are pure encoding and are stripped.
export type DecimalParts = { exponent: number; mantissa: bigint }

export function parseDecimal(input: string): DecimalParts {
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(input.trim())
  if (!match) {
    throw new Error(`invalid decimal: ${input}`)
  }
  const negative = match[1] === '-'
  const whole = match[2]!.replace(/^0+(?=\d)/, '')
  const frac = match[3] ?? ''
  const digits = `${whole}${frac}`
  let mantissa = BigInt(digits)
  if (negative && mantissa !== 0n) {
    mantissa = -mantissa
  }
  // `-frac.length` is negative zero when there is no fraction, and negative zero
  // is not structurally equal to zero. Normalize it away.
  return { exponent: frac.length === 0 ? 0 : -frac.length, mantissa }
}

export function formatDecimal(parts: DecimalParts): string {
  const { exponent, mantissa } = parts
  const negative = mantissa < 0n
  const sign = negative ? '-' : ''
  let digits = (negative ? -mantissa : mantissa).toString()

  if (exponent === 0) {
    return `${sign}${digits}`
  }
  if (exponent > 0) {
    return `${sign}${digits}${'0'.repeat(exponent)}`
  }
  const places = -exponent
  if (digits.length <= places) {
    digits = digits.padStart(places + 1, '0')
  }
  const whole = digits.slice(0, digits.length - places)
  const frac = digits.slice(digits.length - places)
  return `${sign}${whole}.${frac}`
}

// The canonical text of a decimal: leading zeros stripped, trailing zeros kept.
// So "01.20" becomes "1.20", and "1.20" stays "1.20".
export function normalizeDecimal(input: string): string {
  return formatDecimal(parseDecimal(input))
}

// ---------------------------------------------------------------------------
// Encoding
// ---------------------------------------------------------------------------

function writeValue(out: ByteWriter, value: Value): void {
  switch (value.kind) {
    case 'text':
      writeText(out, value.value)
      return
    case 'integer':
      writeInteger(out, value.value)
      return
    case 'decimal': {
      const { exponent, mantissa } = parseDecimal(value.value)
      writeTag(out, TAG_DECIMAL)
      writeArrayHead(out, 2)
      writeInteger(out, BigInt(exponent))
      writeInteger(out, mantissa)
      return
    }
    case 'boolean':
      writeBoolean(out, value.value)
      return
    case 'date':
      writeTag(out, TAG_DATE)
      writeText(out, value.value)
      return
    case 'null':
      writeNull(out)
      return
    case 'ref':
      // a reference carries a tag so a reader can tell it from a blob link
      // without the form. An identity mark carries none, because it sits at the
      // reserved `mark` key and position alone identifies it.
      writeTag(out, TAG_REF)
      writeBytes(out, markToBytes(value.target))
      return
    case 'blob':
      writeTag(out, TAG_BLOB)
      writeText(out, value.hash)
      return
    case 'collection':
      writeCollection(out, value.order, value.items)
      return
    case 'record':
      writeRecord(out, value.record)
      return
  }
}

function writeCollection(
  out: ByteWriter,
  order: CollectionKind,
  items: Array<Item>,
): void {
  // A collection is a map with `order` and `items`. A record is a map with
  // `type` and `fields`. The key sets are disjoint, so a decoder tells them
  // apart without a tag and without the form.
  writeMap(out, [
    ['order', o => writeText(o, order)],
    ['items', o => writeItems(o, order, items)],
  ])
}

function writeItems(
  out: ByteWriter,
  order: CollectionKind,
  items: Array<Item>,
): void {
  const encoded = items.map(item => {
    const itemOut = new ByteWriter()
    writeItem(itemOut, item)
    return { item, bytes: itemOut.done() }
  })

  if (order === 'set') {
    // unordered: order members by their canonical bytes so the same set never
    // produces two encodings
    encoded.sort((a, b) => compareBytes(a.bytes, b.bytes))
  } else if (order === 'map') {
    // addressed by key: order by key, falling back to bytes when keys tie
    encoded.sort((a, b) => {
      const left = a.item.key ?? ''
      const right = b.item.key ?? ''
      if (left !== right) {
        return left < right ? -1 : 1
      }
      return compareBytes(a.bytes, b.bytes)
    })
  }
  // list and log keep their given order, the merge having already ordered a log

  writeArrayHead(out, encoded.length)
  for (const entry of encoded) {
    out.push(entry.bytes)
  }
}

function writeItem(out: ByteWriter, item: Item): void {
  const entries: Array<[string, (o: ByteWriter) => void]> = [
    ['value', o => writeValue(o, item.value)],
  ]
  if (item.mark !== undefined) {
    entries.push(['mark', o => writeBytes(o, markToBytes(item.mark!))])
  }
  if (item.key !== undefined) {
    entries.push(['key', o => writeText(o, item.key!)])
  }
  writeMap(out, entries)
}

function writeRecord(out: ByteWriter, node: RecordNode): void {
  const entries: Array<[string, (o: ByteWriter) => void]> = [
    ['type', o => writeText(o, node.type)],
    [
      'fields',
      o =>
        writeMap(
          o,
          [...node.fields].map(
            ([name, value]) =>
              [name, (inner: ByteWriter) => writeValue(inner, value)] as [
                string,
                (inner: ByteWriter) => void,
              ],
          ),
        ),
    ],
  ]
  // identity: raw 16 bytes, untagged, at the reserved `mark` key
  if (node.mark !== undefined) {
    entries.push(['mark', o => writeBytes(o, markToBytes(node.mark!))])
  }
  if (node.label !== undefined) {
    entries.push(['label', o => writeText(o, node.label!)])
  }
  // comments are content: a record whose comments differ is a different record, so
  // they hash. Absent when there are none, so a record without comments is byte
  // identical to one written before comments existed.
  if (node.comments !== undefined && node.comments.size > 0) {
    entries.push([
      'comments',
      o =>
        writeMap(
          o,
          [...node.comments!].map(
            ([key, lines]) =>
              [
                key,
                (inner: ByteWriter) => {
                  writeArrayHead(inner, lines.length)

                  for (const line of lines) {
                    writeText(inner, line)
                  }
                },
              ] as [string, (inner: ByteWriter) => void],
          ),
        ),
    ])
  }
  writeMap(out, entries)
}

// ---------------------------------------------------------------------------
// The public surface
// ---------------------------------------------------------------------------

// The canonical bytes of a record. This is the form the hash is taken over.
export function canonicalBytes(node: RecordNode): Uint8Array {
  const out = new ByteWriter()
  writeRecord(out, node)
  return out.done()
}

// The canonical bytes of a bare value.
export function canonicalValueBytes(value: Value): Uint8Array {
  const out = new ByteWriter()
  writeValue(out, value)
  return out.done()
}

const HEX_DIGITS = '0123456789abcdef'

export function bytesToBase16(bytes: Uint8Array): string {
  let out = ''
  for (const byte of bytes) {
    out += HEX_DIGITS[byte >> 4]
    out += HEX_DIGITS[byte & 0x0f]
  }
  return out
}

export function base16ToBytes(text: string): Uint8Array {
  if (text.length % 2 !== 0) {
    throw new Error('odd-length base16 input')
  }
  const out = new Uint8Array(text.length / 2)
  for (let i = 0; i < out.length; i++) {
    const byte = parseInt(text.slice(i * 2, i * 2 + 2), 16)
    if (Number.isNaN(byte)) {
      throw new Error('invalid base16 input')
    }
    out[i] = byte
  }
  return out
}

// The canonical bytes as base16 text. Used by the string-keyed store and by
// every equality comparison in the codebase. Lossless, so comparing this is
// equivalent to comparing the bytes.
export function canonicalizeRecord(node: RecordNode): string {
  return bytesToBase16(canonicalBytes(node))
}

export function canonicalizeValue(value: Value): string {
  return bytesToBase16(canonicalValueBytes(value))
}
