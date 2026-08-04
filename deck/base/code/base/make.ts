import type {
  CollectionKind,
  Item,
  Mark,
  RecordNode,
  Value,
} from '@/base/type'

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
