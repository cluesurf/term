import type { CollectionKind, Item, RecordNode, Value } from '@/base/type'
import { normalizeDecimal } from '@/canon/canonicalize'

// Deterministic JSON, for the internal structures that are NOT record graphs:
// commit objects, changesets, prolly-tree nodes, revocation lists, and
// off-history payloads. These are addressed by hash too, so they need a
// deterministic encoding, but they are base's own bookkeeping rather than the
// versioned data.
//
// THIS IS NOT THE CANONICAL RECORD FORM. Records serialize to DAG-CBOR, in
// canonicalize.ts. Migrating these internal structures to CBOR as well is
// follow-up work tracked in the hardening roadmap. Keeping them separate is
// deliberate, so nobody mistakes this for the format other implementations must
// agree with.
//
// See note/library/base/20-serialization-and-wire-format.md.

// A plain JSON-serializable intermediate. Arrays preserve order; object keys are
// sorted at stringify time.
export type Canon =
  | string
  | boolean
  | Array<Canon>
  | { [key: string]: Canon }

export function toCanonValue(value: Value): Canon {
  switch (value.kind) {
    case 'text':
      return ['t', value.value]
    case 'integer':
      return ['i', value.value.toString()]
    case 'decimal':
      return ['d', normalizeDecimal(value.value)]
    case 'boolean':
      return ['b', value.value]
    case 'date':
      return ['a', value.value]
    case 'null':
      return ['n']
    case 'ref':
      return ['r', value.target]
    case 'blob':
      return ['l', value.hash]
    case 'collection':
      return ['c', value.order, canonItems(value.order, value.items)]
    case 'record':
      return ['e', toCanonRecord(value.record)]
  }
}

function canonItems(
  order: CollectionKind,
  items: Array<Item>,
): Array<Canon> {
  const encoded = items.map(toCanonItem)
  if (order === 'set') {
    return encoded
      .map(e => ({ e, s: canonicalString(e) }))
      .sort((a, b) => (a.s < b.s ? -1 : a.s > b.s ? 1 : 0))
      .map(x => x.e)
  }
  if (order === 'map') {
    return encoded
      .map(e => ({ e, k: keyOf(e) }))
      .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0))
      .map(x => x.e)
  }
  return encoded
}

function keyOf(item: Canon): string {
  if (typeof item === 'object' && !Array.isArray(item) && item !== null) {
    return (item.k as string) ?? ''
  }
  return ''
}

function toCanonItem(it: Item): Canon {
  const out: { [key: string]: Canon } = { v: toCanonValue(it.value) }
  if (it.mark !== undefined) {
    out.m = it.mark
  }
  if (it.key !== undefined) {
    out.k = it.key
  }
  return out
}

export function toCanonRecord(node: RecordNode): { [key: string]: Canon } {
  const fields: { [key: string]: Canon } = {}
  for (const [name, value] of node.fields) {
    fields[name] = toCanonValue(value)
  }
  const out: { [key: string]: Canon } = { type: node.type, fields }
  if (node.mark !== undefined) {
    out.mark = node.mark
  }
  if (node.label !== undefined) {
    out.label = node.label
  }
  return out
}

// Deterministic stringify: arrays keep order, object keys are sorted by code
// point, strings are JSON-escaped, no incidental whitespace.
export function canonicalString(value: Canon): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalString).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const keys = Object.keys(value).sort()
    const parts = keys.map(
      k => `${JSON.stringify(k)}:${canonicalString(value[k]!)}`,
    )
    return `{${parts.join(',')}}`
  }
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false'
  }
  return JSON.stringify(value)
}

export function fromCanonValue(canon: Canon): Value {
  if (!Array.isArray(canon)) {
    throw new Error('malformed value node')
  }
  const tag = canon[0]
  switch (tag) {
    case 't':
      return { kind: 'text', value: canon[1] as string }
    case 'i':
      return { kind: 'integer', value: BigInt(canon[1] as string) }
    case 'd':
      return { kind: 'decimal', value: canon[1] as string }
    case 'b':
      return { kind: 'boolean', value: canon[1] as boolean }
    case 'a':
      return { kind: 'date', value: canon[1] as string }
    case 'n':
      return { kind: 'null' }
    case 'r':
      return { kind: 'ref', target: canon[1] as string }
    case 'l':
      return { kind: 'blob', hash: canon[1] as string }
    case 'c':
      return {
        kind: 'collection',
        order: canon[1] as CollectionKind,
        items: (canon[2] as Array<Canon>).map(fromCanonItem),
      }
    case 'e':
      return {
        kind: 'record',
        record: fromCanonRecord(canon[1] as { [key: string]: Canon }),
      }
    default:
      throw new Error(`unknown value tag ${String(tag)}`)
  }
}

function fromCanonItem(canon: Canon): Item {
  if (typeof canon !== 'object' || Array.isArray(canon) || canon === null) {
    throw new Error('malformed item node')
  }
  const out: Item = { value: fromCanonValue(canon.v!) }
  if (canon.m !== undefined) {
    out.mark = canon.m as string
  }
  if (canon.k !== undefined) {
    out.key = canon.k as string
  }
  return out
}

export function fromCanonRecord(canon: {
  [key: string]: Canon
}): RecordNode {
  const fields = new Map<string, Value>()
  const fieldObj = canon.fields as { [key: string]: Canon }
  for (const name of Object.keys(fieldObj)) {
    fields.set(name, fromCanonValue(fieldObj[name]!))
  }
  const node: RecordNode = { type: canon.type as string, fields }
  if (canon.mark !== undefined) {
    node.mark = canon.mark as string
  }
  if (canon.label !== undefined) {
    node.label = canon.label as string
  }
  return node
}
