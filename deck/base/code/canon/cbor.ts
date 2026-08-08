// Deterministic CBOR, the DAG-CBOR profile. This is the canonical form: the bytes
// that get hashed, and therefore the only encoding whose exact output is load
// bearing. Everything here is written so one value produces exactly one byte
// sequence, on any implementation.
//
// The rules, per note/library/base/20-serialization-and-wire-format.md:
//
//   - integers and lengths use the SMALLEST head that fits
//   - map keys are text strings, sorted BYTEWISE over the key's raw UTF-8 bytes,
//     with length never consulted. This DIVERGES from RFC 8949 4.2.1, which
//     sorts the encoded keys: because CBOR puts the length in the head byte,
//     sorting encodings makes length the primary key for short strings, which is
//     the length-first behaviour this format rejects. Sorting raw bytes is the
//     simpler rule to state and the one a reader assumes.
//   - no indefinite-length items, ever
//   - no floating point, ever
//
// See note/library/base/20-serialization-and-wire-format.md.

// Major types, the high three bits of the head byte.
const MAJOR_UNSIGNED = 0
const MAJOR_NEGATIVE = 1
const MAJOR_BYTES = 2
const MAJOR_TEXT = 3
const MAJOR_ARRAY = 4
const MAJOR_MAP = 5
const MAJOR_TAG = 6
const MAJOR_SIMPLE = 7

const SIMPLE_FALSE = 20
const SIMPLE_TRUE = 21
const SIMPLE_NULL = 22

// Tags. Standard CBOR tags are used where one exists, so generic tooling can
// decode base bytes without knowing base.
export const TAG_BIGNUM_POSITIVE = 2 // RFC 8949
export const TAG_BIGNUM_NEGATIVE = 3 // RFC 8949
export const TAG_DECIMAL = 4 // RFC 8949 decimal fraction, [exponent, mantissa]
export const TAG_DATE = 0 // RFC 8949 standard date/time string

// base-specific tags. PROVISIONAL: these sit in the first-come-first-served
// range and must be registered before the format is published. Tracked as an
// open item in doc 20.
export const TAG_REF = 40000 // a reference to a record, by mark
export const TAG_BLOB = 40001 // a reference to binary content, by hash

// The canonical form version, written into a repository header so a future
// change to these rules is detectable rather than silently corrupting.
export const CANONICAL_FORM_VERSION = 1

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

// A growable byte buffer. Backed by ONE Uint8Array that doubles as needed, so a head
// byte, a boolean, or a null costs a single array-store rather than a fresh
// one-element Uint8Array and a later concat. Encoding runs on every field-set and
// commit (it is the hash input), so this is the hottest allocation path in the engine.
export class ByteWriter {
  private buffer = new Uint8Array(64)
  private length = 0

  private ensure(extra: number): void {
    const needed = this.length + extra
    if (needed <= this.buffer.length) {
      return
    }
    let capacity = this.buffer.length * 2
    while (capacity < needed) {
      capacity *= 2
    }
    const grown = new Uint8Array(capacity)
    grown.set(this.buffer.subarray(0, this.length))
    this.buffer = grown
  }

  push(bytes: Uint8Array): void {
    this.ensure(bytes.length)
    this.buffer.set(bytes, this.length)
    this.length += bytes.length
  }

  byte(value: number): void {
    this.ensure(1)
    this.buffer[this.length++] = value & 0xff
  }

  done(): Uint8Array {
    // a copy sized to exactly the written bytes, so callers own an independent array
    return this.buffer.slice(0, this.length)
  }
}

// The head of an item: the major type plus the argument, in the smallest form
// that represents the argument. This is the whole of deterministic length
// encoding, so every writer below routes through it.
export function writeHead(
  out: ByteWriter,
  major: number,
  argument: bigint,
): void {
  const high = major << 5
  if (argument < 24n) {
    out.byte(high | Number(argument))
  } else if (argument <= 0xffn) {
    out.byte(high | 24)
    out.byte(Number(argument))
  } else if (argument <= 0xffffn) {
    out.byte(high | 25)
    out.push(bigintToBytes(argument, 2))
  } else if (argument <= 0xffffffffn) {
    out.byte(high | 26)
    out.push(bigintToBytes(argument, 4))
  } else if (argument <= 0xffffffffffffffffn) {
    out.byte(high | 27)
    out.push(bigintToBytes(argument, 8))
  } else {
    throw new Error('argument exceeds the 64-bit CBOR head')
  }
}

function bigintToBytes(value: bigint, width: number): Uint8Array {
  const out = new Uint8Array(width)
  let rest = value
  for (let i = width - 1; i >= 0; i--) {
    out[i] = Number(rest & 0xffn)
    rest >>= 8n
  }
  return out
}

// The minimal big-endian byte representation of a non-negative bigint, for the
// bignum tags. Zero is the empty string, per the bignum convention.
export function bigintToMinimalBytes(value: bigint): Uint8Array {
  if (value === 0n) {
    return new Uint8Array(0)
  }
  const hex = value.toString(16)
  const padded = hex.length % 2 === 1 ? `0${hex}` : hex
  const out = new Uint8Array(padded.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(padded.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

function bytesToBigint(bytes: Uint8Array): bigint {
  let out = 0n
  for (const byte of bytes) {
    out = (out << 8n) | BigInt(byte)
  }
  return out
}

export function writeTag(out: ByteWriter, tag: number): void {
  writeHead(out, MAJOR_TAG, BigInt(tag))
}

// An integer of arbitrary size. Values inside the 64-bit range use the compact
// major-type form; anything larger falls back to a bignum tag, which is what
// keeps precision unbounded without introducing floats.
export function writeInteger(out: ByteWriter, value: bigint): void {
  if (value >= 0n) {
    if (value <= 0xffffffffffffffffn) {
      writeHead(out, MAJOR_UNSIGNED, value)
      return
    }
    writeTag(out, TAG_BIGNUM_POSITIVE)
    writeBytes(out, bigintToMinimalBytes(value))
    return
  }
  const encoded = -1n - value
  if (encoded <= 0xffffffffffffffffn) {
    writeHead(out, MAJOR_NEGATIVE, encoded)
    return
  }
  writeTag(out, TAG_BIGNUM_NEGATIVE)
  writeBytes(out, bigintToMinimalBytes(encoded))
}

export function writeBytes(out: ByteWriter, bytes: Uint8Array): void {
  writeHead(out, MAJOR_BYTES, BigInt(bytes.length))
  out.push(bytes)
}

const encoder = new TextEncoder()

// Text is NFC-normalized before encoding, so two spellings of the same string
// never produce two hashes.
export function writeText(out: ByteWriter, text: string): void {
  const bytes = encoder.encode(text.normalize('NFC'))
  writeHead(out, MAJOR_TEXT, BigInt(bytes.length))
  out.push(bytes)
}

export function writeArrayHead(out: ByteWriter, length: number): void {
  writeHead(out, MAJOR_ARRAY, BigInt(length))
}

export function writeBoolean(out: ByteWriter, value: boolean): void {
  out.byte((MAJOR_SIMPLE << 5) | (value ? SIMPLE_TRUE : SIMPLE_FALSE))
}

export function writeNull(out: ByteWriter): void {
  out.byte((MAJOR_SIMPLE << 5) | SIMPLE_NULL)
}

// The raw UTF-8 bytes of a key, NFC-normalized. Sorting these rather than the
// host language's string comparison is what makes the order independent of
// locale and collation.
export function keySortBytes(key: string): Uint8Array {
  return encoder.encode(key.normalize('NFC'))
}

// A map, with keys sorted bytewise over their RAW UTF-8 bytes. Length is never
// consulted, so "aa" precedes "z".
export function writeMap(
  out: ByteWriter,
  entries: Array<[string, (out: ByteWriter) => void]>,
): void {
  const encoded = entries.map(([key, writeValue]) => {
    const keyOut = new ByteWriter()
    writeText(keyOut, key)
    return { key: keyOut.done(), sort: keySortBytes(key), writeValue }
  })
  encoded.sort((a, b) => compareBytes(a.sort, b.sort))
  // Two keys that are distinct JS strings but equal after NFC (e.g. "é"
  // and "é") encode to identical key bytes. The decoder's canonical-order
  // guard would then reject the chunk as "keys out of order", making a record
  // that stored fine permanently unreadable. Reject it here at encode time
  // instead, symmetric with the decoder, so the collision never reaches storage.
  for (let i = 1; i < encoded.length; i++) {
    if (compareBytes(encoded[i - 1]!.sort, encoded[i]!.sort) === 0) {
      throw new Error('duplicate map key after NFC normalization')
    }
  }
  writeHead(out, MAJOR_MAP, BigInt(encoded.length))
  for (const entry of encoded) {
    out.push(entry.key)
    entry.writeValue(out)
  }
}

// Bytewise comparison, shorter-is-smaller only when one is a prefix of the other.
export function compareBytes(a: Uint8Array, b: Uint8Array): number {
  const shared = Math.min(a.length, b.length)
  for (let i = 0; i < shared; i++) {
    if (a[i] !== b[i]) {
      return a[i]! < b[i]! ? -1 : 1
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

export type CborValue =
  | { kind: 'integer'; value: bigint }
  | { kind: 'bytes'; value: Uint8Array }
  | { kind: 'text'; value: string }
  | { kind: 'array'; value: Array<CborValue> }
  | { kind: 'map'; value: Array<[string, CborValue]> }
  | { kind: 'tag'; tag: number; value: CborValue }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }

export class ByteReader {
  private at = 0

  constructor(private readonly bytes: Uint8Array) {}

  get offset(): number {
    return this.at
  }

  get exhausted(): boolean {
    return this.at >= this.bytes.length
  }

  take(count: number): Uint8Array {
    if (this.at + count > this.bytes.length) {
      throw new Error('truncated CBOR input')
    }
    const out = this.bytes.subarray(this.at, this.at + count)
    this.at += count
    return out
  }

  takeByte(): number {
    if (this.at >= this.bytes.length) {
      throw new Error('truncated CBOR input')
    }
    return this.bytes[this.at++]!
  }
}

const decoder = new TextDecoder('utf-8', { fatal: true })

function readArgument(reader: ByteReader, info: number): bigint {
  if (info < 24) {
    return BigInt(info)
  }
  if (info === 24) {
    return BigInt(reader.takeByte())
  }
  if (info === 25) {
    return bytesToBigint(reader.take(2))
  }
  if (info === 26) {
    return bytesToBigint(reader.take(4))
  }
  if (info === 27) {
    return bytesToBigint(reader.take(8))
  }
  if (info === 31) {
    throw new Error('indefinite-length items are not permitted')
  }
  throw new Error(`reserved additional information ${info}`)
}

// Reject a head that could have been written smaller. A decoder that accepts a
// non-minimal head would accept two byte sequences for one value, which breaks
// the one-value-one-encoding guarantee the hash depends on.
function assertMinimalHead(info: number, argument: bigint): void {
  if (info < 24) {
    return
  }
  const minimal =
    argument < 24n
      ? 0
      : argument <= 0xffn
        ? 24
        : argument <= 0xffffn
          ? 25
          : argument <= 0xffffffffn
            ? 26
            : 27
  if (info !== minimal) {
    throw new Error('non-minimal integer encoding')
  }
}

// The deepest a canonical value may nest on decode. A real record graph nests a
// handful of levels; this is far above that and far below the call-stack limit, so
// hostile CBOR (a long run of array/map/tag heads from an untrusted peer or a CDN
// read) is rejected with a catchable error instead of overflowing the stack.
const MAX_DECODE_DEPTH = 1024

export function readValue(reader: ByteReader, depth = 0): CborValue {
  if (depth > MAX_DECODE_DEPTH) {
    throw new Error('canonical value nests too deep')
  }
  const head = reader.takeByte()
  const major = head >> 5
  const info = head & 0x1f

  if (major === MAJOR_SIMPLE) {
    if (info === SIMPLE_TRUE) {
      return { kind: 'boolean', value: true }
    }
    if (info === SIMPLE_FALSE) {
      return { kind: 'boolean', value: false }
    }
    if (info === SIMPLE_NULL) {
      return { kind: 'null' }
    }
    if (info === 25 || info === 26 || info === 27) {
      throw new Error('floating point is not permitted in the canonical form')
    }
    throw new Error(`unsupported simple value ${info}`)
  }

  const argument = readArgument(reader, info)
  assertMinimalHead(info, argument)

  switch (major) {
    case MAJOR_UNSIGNED:
      return { kind: 'integer', value: argument }
    case MAJOR_NEGATIVE:
      return { kind: 'integer', value: -1n - argument }
    case MAJOR_BYTES:
      return { kind: 'bytes', value: reader.take(Number(argument)) }
    case MAJOR_TEXT:
      return {
        kind: 'text',
        value: decoder.decode(reader.take(Number(argument))),
      }
    case MAJOR_ARRAY: {
      const items: Array<CborValue> = []
      for (let i = 0n; i < argument; i++) {
        items.push(readValue(reader, depth + 1))
      }
      return { kind: 'array', value: items }
    }
    case MAJOR_MAP: {
      const entries: Array<[string, CborValue]> = []
      let previous: Uint8Array | undefined
      for (let i = 0n; i < argument; i++) {
        const keyStart = reader.offset
        const key = readValue(reader, depth + 1)
        if (key.kind !== 'text') {
          throw new Error('canonical map keys must be text strings')
        }
        // compare in the same space the writer sorted in: raw UTF-8 bytes
        const keyBytes = keySortBytes(key.value)
        if (previous !== undefined && compareBytes(previous, keyBytes) >= 0) {
          throw new Error(
            `map keys out of canonical order at offset ${keyStart}`,
          )
        }
        previous = keyBytes
        entries.push([key.value, readValue(reader, depth + 1)])
      }
      return { kind: 'map', value: entries }
    }
    case MAJOR_TAG:
      return {
        kind: 'tag',
        tag: Number(argument),
        value: readValue(reader, depth + 1),
      }
    default:
      throw new Error(`unsupported major type ${major}`)
  }
}

// Decode exactly one value and require the input to be fully consumed. Trailing
// bytes mean the input is not what it claims to be.
export function decodeOne(bytes: Uint8Array): CborValue {
  const reader = new ByteReader(bytes)
  const value = readValue(reader)
  if (!reader.exhausted) {
    throw new Error('trailing bytes after the canonical value')
  }
  return value
}

// A bignum-tagged value back to a bigint.
export function bignumToBigint(tag: number, bytes: Uint8Array): bigint {
  const magnitude = bytesToBigint(bytes)
  return tag === TAG_BIGNUM_POSITIVE ? magnitude : -1n - magnitude
}
