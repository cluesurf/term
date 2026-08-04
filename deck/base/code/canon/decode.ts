import type { CollectionKind, Item, RecordNode, Value } from '@/base/type'
import {
  bignumToBigint,
  decodeOne,
  TAG_BIGNUM_NEGATIVE,
  TAG_BIGNUM_POSITIVE,
  TAG_BLOB,
  TAG_DATE,
  TAG_DECIMAL,
  TAG_REF,
  type CborValue,
} from '@/canon/cbor'
import { base16ToBytes, formatDecimal } from '@/canon/canonicalize'
import { bytesToMark } from '@/canon/mark'

// The inverse of canonicalization. Canonical bytes are DAG-CBOR, so decoding is
// a CBOR read followed by a mapping back into the record graph. This is how the
// content-addressed store reads records back from their canonical bytes.
//
// Decoding is STRICT. A non-minimal integer head, an out-of-order map key, an
// indefinite-length item, a float, or trailing bytes are all rejected, because
// accepting any of them would mean two byte sequences for one value.

const COLLECTION_KINDS = new Set(['list', 'set', 'map', 'log'])

function expectMap(value: CborValue): Map<string, CborValue> {
  if (value.kind !== 'map') {
    throw new Error(`expected a map, got ${value.kind}`)
  }
  return new Map(value.value)
}

function expectText(value: CborValue | undefined, what: string): string {
  if (value === undefined || value.kind !== 'text') {
    throw new Error(`expected text for ${what}`)
  }
  return value.value
}

function expectBytes(value: CborValue | undefined, what: string): Uint8Array {
  if (value === undefined || value.kind !== 'bytes') {
    throw new Error(`expected bytes for ${what}`)
  }
  return value.value
}

function integerOf(value: CborValue, what: string): bigint {
  if (value.kind === 'integer') {
    return value.value
  }
  if (
    value.kind === 'tag' &&
    (value.tag === TAG_BIGNUM_POSITIVE || value.tag === TAG_BIGNUM_NEGATIVE)
  ) {
    return bignumToBigint(value.tag, expectBytes(value.value, what))
  }
  throw new Error(`expected an integer for ${what}`)
}

export function fromCborValue(value: CborValue): Value {
  switch (value.kind) {
    case 'text':
      return { kind: 'text', value: value.value }
    case 'integer':
      return { kind: 'integer', value: value.value }
    case 'boolean':
      return { kind: 'boolean', value: value.value }
    case 'null':
      return { kind: 'null' }
    case 'bytes':
      throw new Error('a bare byte string is not a value')
    case 'array':
      throw new Error('a bare array is not a value')
    case 'tag':
      switch (value.tag) {
        case TAG_DATE:
          return { kind: 'date', value: expectText(value.value, 'date') }
        case TAG_REF:
          return {
            kind: 'ref',
            target: bytesToMark(expectBytes(value.value, 'ref')),
          }
        case TAG_BLOB:
          return { kind: 'blob', hash: expectText(value.value, 'blob') }
        case TAG_DECIMAL: {
          if (value.value.kind !== 'array' || value.value.value.length !== 2) {
            throw new Error('a decimal must be [exponent, mantissa]')
          }
          const exponent = Number(
            integerOf(value.value.value[0]!, 'decimal exponent'),
          )
          const mantissa = integerOf(value.value.value[1]!, 'decimal mantissa')
          return {
            kind: 'decimal',
            value: formatDecimal({ exponent, mantissa }),
          }
        }
        case TAG_BIGNUM_POSITIVE:
        case TAG_BIGNUM_NEGATIVE:
          return {
            kind: 'integer',
            value: bignumToBigint(
              value.tag,
              expectBytes(value.value, 'bignum'),
            ),
          }
        default:
          throw new Error(`unknown tag ${value.tag}`)
      }
    case 'map': {
      const entries = new Map(value.value)
      // a record carries `type`, a collection carries `order`. Disjoint, so the
      // shape is readable without the form.
      if (entries.has('type')) {
        return { kind: 'record', record: recordFromMap(entries) }
      }
      if (entries.has('order')) {
        const order = expectText(entries.get('order'), 'collection order')
        if (!COLLECTION_KINDS.has(order)) {
          throw new Error(`unknown collection kind ${order}`)
        }
        const items = entries.get('items')
        if (items === undefined || items.kind !== 'array') {
          throw new Error('a collection needs an items array')
        }
        return {
          kind: 'collection',
          order: order as CollectionKind,
          items: items.value.map(itemFromCbor),
        }
      }
      throw new Error('a map value must be a record or a collection')
    }
  }
}

function itemFromCbor(value: CborValue): Item {
  const entries = expectMap(value)
  const inner = entries.get('value')
  if (inner === undefined) {
    throw new Error('an item needs a value')
  }
  const out: Item = { value: fromCborValue(inner) }
  const mark = entries.get('mark')
  if (mark !== undefined) {
    out.mark = bytesToMark(expectBytes(mark, 'item mark'))
  }
  const key = entries.get('key')
  if (key !== undefined) {
    out.key = expectText(key, 'item key')
  }
  return out
}

function recordFromMap(entries: Map<string, CborValue>): RecordNode {
  const fieldsValue = entries.get('fields')
  if (fieldsValue === undefined || fieldsValue.kind !== 'map') {
    throw new Error('a record needs a fields map')
  }
  const fields = new Map<string, Value>()
  for (const [name, value] of fieldsValue.value) {
    fields.set(name, fromCborValue(value))
  }
  const node: RecordNode = {
    type: expectText(entries.get('type'), 'record type'),
    fields,
  }
  const mark = entries.get('mark')
  if (mark !== undefined) {
    node.mark = bytesToMark(expectBytes(mark, 'record mark'))
  }
  const label = entries.get('label')
  if (label !== undefined) {
    node.label = expectText(label, 'record label')
  }
  return node
}

// Decode a record from its canonical bytes.
export function decodeRecordBytes(bytes: Uint8Array): RecordNode {
  const value = decodeOne(bytes)
  if (value.kind !== 'map') {
    throw new Error('canonical record bytes must decode to a map')
  }
  return recordFromMap(new Map(value.value))
}

// Decode a bare value from its canonical bytes.
export function decodeValueBytes(bytes: Uint8Array): Value {
  return fromCborValue(decodeOne(bytes))
}

// Decode a record from the base16 text form the string-keyed store holds.
export function decodeRecord(text: string): RecordNode {
  return decodeRecordBytes(base16ToBytes(text))
}

// Decode a bare value from its base16 text form.
export function decodeValue(text: string): Value {
  return decodeValueBytes(base16ToBytes(text))
}
