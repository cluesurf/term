import type {
  CollectionKind,
  Item,
  RecordNode,
  Value,
} from '@term/base/code/base/type'
import type { Change, Comments } from '@term/base/code/diff/change'

// Parse the JSON body of an API write into typed engine values.
//
// The HTTP wire form is plain JSON, so a record's `fields` arrive as an object (not a
// Map), an integer as a string or number (JSON has no bigint), and a change as an
// untyped object. Casting that straight to `Change` — as the commit handler used to —
// stores a malformed record (object fields where a Map is expected) or throws deep
// inside applyChanges on a bad shape, surfacing as a 500. This module validates every
// change against the discriminated union and normalizes it (fields to a Map, integers
// to bigint, values recursively), throwing `WireError` on anything malformed so the
// handler can answer 422 instead.

export class WireError extends Error {}

function fail(reason: string): never {
  throw new WireError(reason)
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

const COLLECTION_ORDERS: ReadonlyArray<CollectionKind> = [
  'list',
  'set',
  'map',
  'log',
]

function parseValue(raw: unknown): Value {
  if (!isObject(raw) || typeof raw.kind !== 'string') {
    fail('value must be an object with a kind')
  }
  switch (raw.kind) {
    case 'text':
    case 'decimal':
    case 'date':
      if (typeof raw.value !== 'string') {
        fail(`${raw.kind} value must be a string`)
      }
      return { kind: raw.kind, value: raw.value } as Value
    case 'integer':
      // JSON has no bigint, so an integer arrives as a string or a whole number
      try {
        if (typeof raw.value === 'string') {
          return { kind: 'integer', value: BigInt(raw.value) }
        }
        if (typeof raw.value === 'number' && Number.isInteger(raw.value)) {
          return { kind: 'integer', value: BigInt(raw.value) }
        }
      } catch {
        fail('integer value is not a valid integer')
      }
      return fail('integer value must be a whole number or a numeric string')
    case 'boolean':
      if (typeof raw.value !== 'boolean') {
        fail('boolean value must be true or false')
      }
      return { kind: 'boolean', value: raw.value }
    case 'null':
      return { kind: 'null' }
    case 'ref':
      if (typeof raw.target !== 'string') {
        fail('ref target must be a string')
      }
      return { kind: 'ref', target: raw.target }
    case 'blob':
      if (typeof raw.hash !== 'string') {
        fail('blob hash must be a string')
      }
      return { kind: 'blob', hash: raw.hash }
    case 'collection': {
      if (!COLLECTION_ORDERS.includes(raw.order as CollectionKind)) {
        fail('collection order must be list, set, map, or log')
      }
      if (!Array.isArray(raw.items)) {
        fail('collection items must be an array')
      }
      return {
        kind: 'collection',
        order: raw.order as CollectionKind,
        items: raw.items.map(parseItem),
      }
    }
    case 'record':
      return { kind: 'record', record: parseRecord(raw.record) }
    default:
      return fail(`unknown value kind ${String(raw.kind)}`)
  }
}

function parseItem(raw: unknown): Item {
  if (!isObject(raw)) {
    fail('collection item must be an object')
  }
  const item: Item = { value: parseValue(raw.value) }
  if (raw.mark !== undefined) {
    if (typeof raw.mark !== 'string') {
      fail('item mark must be a string')
    }
    item.mark = raw.mark
  }
  if (raw.key !== undefined) {
    if (typeof raw.key !== 'string') {
      fail('item key must be a string')
    }
    item.key = raw.key
  }
  return item
}

function parseFields(raw: unknown): Map<string, Value> {
  if (!isObject(raw)) {
    fail('record fields must be an object')
  }
  const fields = new Map<string, Value>()
  for (const name of Object.keys(raw)) {
    fields.set(name, parseValue(raw[name]))
  }
  return fields
}

function parseComments(raw: unknown): Comments {
  if (!isObject(raw)) {
    fail('comments must be an object')
  }
  const comments: Comments = new Map()
  for (const key of Object.keys(raw)) {
    const lines = raw[key]
    if (!Array.isArray(lines) || lines.some(l => typeof l !== 'string')) {
      fail('comment lines must be an array of strings')
    }
    comments.set(key, lines as Array<string>)
  }
  return comments
}

function parseRecord(raw: unknown): RecordNode {
  if (!isObject(raw) || typeof raw.type !== 'string') {
    fail('record must be an object with a type')
  }
  const node: RecordNode = {
    type: raw.type,
    fields: parseFields(raw.fields),
  }
  if (raw.mark !== undefined) {
    if (typeof raw.mark !== 'string') {
      fail('record mark must be a string')
    }
    node.mark = raw.mark
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== 'string') {
      fail('record label must be a string')
    }
    node.label = raw.label
  }
  if (raw.comments !== undefined) {
    node.comments = parseComments(raw.comments)
  }
  return node
}

function requireMark(raw: Record<string, unknown>): string {
  if (typeof raw.mark !== 'string' || raw.mark.length === 0) {
    fail('change mark must be a non-empty string')
  }
  return raw.mark
}

function requireField(raw: Record<string, unknown>): string {
  if (typeof raw.field !== 'string') {
    fail('field change must name a field')
  }
  return raw.field
}

function parseChange(raw: unknown): Change {
  if (!isObject(raw) || typeof raw.type !== 'string') {
    fail('change must be an object with a type')
  }
  switch (raw.type) {
    case 'record.add':
      return { type: 'record.add', mark: requireMark(raw), value: parseRecord(raw.value) }
    case 'record.remove':
      return { type: 'record.remove', mark: requireMark(raw), before: parseRecord(raw.before) }
    case 'field.set':
      return {
        type: 'field.set',
        mark: requireMark(raw),
        field: requireField(raw),
        before: raw.before === undefined ? undefined : parseValue(raw.before),
        after: parseValue(raw.after),
      }
    case 'field.remove':
      return {
        type: 'field.remove',
        mark: requireMark(raw),
        field: requireField(raw),
        before: parseValue(raw.before),
      }
    case 'record.relabel':
      return {
        type: 'record.relabel',
        mark: requireMark(raw),
        before: raw.before === undefined ? undefined : String(raw.before),
        after: raw.after === undefined ? undefined : String(raw.after),
      }
    case 'record.retype':
      if (typeof raw.before !== 'string' || typeof raw.after !== 'string') {
        fail('record.retype needs before and after type names')
      }
      return { type: 'record.retype', mark: requireMark(raw), before: raw.before, after: raw.after }
    case 'record.recomment':
      return {
        type: 'record.recomment',
        mark: requireMark(raw),
        before: raw.before === undefined ? undefined : parseComments(raw.before),
        after: raw.after === undefined ? undefined : parseComments(raw.after),
      }
    default:
      return fail(`unknown change type ${String(raw.type)}`)
  }
}

// Parse the `changes` field of a write body into a validated, normalized change list.
// Throws WireError on anything malformed.
export function parseChanges(raw: unknown): Array<Change> {
  if (raw === undefined) {
    return []
  }
  if (!Array.isArray(raw)) {
    fail('changes must be an array')
  }
  return raw.map(parseChange)
}
