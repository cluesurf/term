import type {
  CollectionKind,
  Item,
  Mark,
  RecordNode,
  Value,
} from '@term/base/code/base/type'

// Ergonomic builders for values and records. These construct the canonical model
// in code and tests without hand-writing the tagged unions everywhere.

export function text(value: string): Value {
  return { kind: 'text', value }
}

export function integer(value: bigint | number): Value {
  return { kind: 'integer', value: BigInt(value) }
}

export function decimal(value: string): Value {
  return { kind: 'decimal', value }
}

export function boolean(value: boolean): Value {
  return { kind: 'boolean', value }
}

export function date(value: string): Value {
  return { kind: 'date', value }
}

export function nul(): Value {
  return { kind: 'null' }
}

export function ref(target: Mark): Value {
  return { kind: 'ref', target }
}

export function blob(hash: string): Value {
  return { kind: 'blob', hash }
}

export function collection(
  order: CollectionKind,
  items: Array<Item>,
): Value {
  return { kind: 'collection', order, items }
}

export function list(items: Array<Item>): Value {
  return collection('list', items)
}

export function set(items: Array<Item>): Value {
  return collection('set', items)
}

export function log(items: Array<Item>): Value {
  return collection('log', items)
}

export function map(items: Array<Item>): Value {
  return collection('map', items)
}

export function item(value: Value, mark?: Mark, key?: string): Item {
  const out: Item = { value }
  if (mark !== undefined) {
    out.mark = mark
  }
  if (key !== undefined) {
    out.key = key
  }
  return out
}

export function nested(record: RecordNode): Value {
  return { kind: 'record', record }
}

// Build a record node. Fields may be passed as a plain object for convenience and
// are converted to the internal Map.
export function record(input: {
  type: string
  mark?: Mark
  label?: string
  fields?: Record<string, Value>
}): RecordNode {
  const fields = new Map<string, Value>()
  if (input.fields) {
    for (const name of Object.keys(input.fields)) {
      fields.set(name, input.fields[name]!)
    }
  }
  const node: RecordNode = { type: input.type, fields }
  if (input.mark !== undefined) {
    node.mark = input.mark
  }
  if (input.label !== undefined) {
    node.label = input.label
  }
  return node
}

/**
 * A plain JavaScript value as a base `Value`, or nothing when it carries nothing.
 *
 * The seam every importer needs: data arrives as JSON, as a database row, or as a parsed
 * file, and all of it is ordinary JS. Written once here rather than in each importer,
 * because two converters disagree about `null` or about a big integer eventually, and the
 * disagreement shows up as a field that is present in one path and absent in the other.
 *
 * `undefined` means the value carries nothing and the FIELD SHOULD BE OMITTED. A record
 * with no `gloss` and a record with an empty `gloss` are different facts, and collapsing
 * them would make a missing column indistinguishable from a blank one after a round trip.
 * `null` is therefore absence, not a stored null: an explicit null is `nul()`.
 *
 * An integer that does not fit a double becomes `decimal` rather than losing precision
 * silently. That case only arises from a source that already lost it, so the value is
 * preserved as text and the caller can see what it was.
 */
export function valueOf(input: unknown): Value | undefined {
  if (input === null || input === undefined) {
    return undefined
  }

  if (typeof input === 'string') {
    return text(input)
  }

  if (typeof input === 'bigint') {
    return integer(input)
  }

  if (typeof input === 'number') {
    if (!Number.isFinite(input)) {
      // NaN and the infinities have no canonical form and no column type. Refusing here
      // keeps them out of the store rather than out of a later, more confusing error.
      return undefined
    }

    return Number.isInteger(input) && Number.isSafeInteger(input)
      ? integer(input)
      : decimal(String(input))
  }

  if (typeof input === 'boolean') {
    return boolean(input)
  }

  if (input instanceof Date) {
    return date(input.toISOString())
  }

  if (Array.isArray(input)) {
    // A list, recursing, so an array of scalars round trips as one. An element that
    // carries nothing becomes an explicit null rather than shortening the list, because
    // position is part of what a list means.
    return list(input.map(one => ({ value: valueOf(one) ?? nul() })))
  }

  if (typeof input === 'object') {
    const fields: Record<string, Value> = {}

    for (const [name, inner] of Object.entries(input as Record<string, unknown>)) {
      const value = valueOf(inner)

      if (value !== undefined) {
        fields[name] = value
      }
    }

    return { kind: 'record', record: record({ type: 'object', fields }) }
  }

  // a function or a symbol, which is not data
  return undefined
}
