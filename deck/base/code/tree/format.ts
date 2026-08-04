import type { Item, RecordNode, Value } from '@/base/type'
import { normalizeDecimal } from '@/canon/canonicalize'

// Render a record graph to canonical .tree text: the readable authoring syntax.
// A record is `type label`; the mark comes first; scalars are `name value` (typed
// values use an @marker); nested records use `@record`; collections use `@list`,
// `@set`, `@log`, or `@map` with `-` items. This is a projection of the record, so
// it round-trips with the parser.
//
// See note/library/base/02-tree-syntax.md.

const IND = '  '

function encodeScalar(value: Value): string {
  switch (value.kind) {
    case 'text':
      return value.value
    case 'integer':
      return `@integer ${value.value.toString()}`
    case 'decimal':
      return `@decimal ${normalizeDecimal(value.value)}`
    case 'boolean':
      return `@boolean ${value.value ? 'true' : 'false'}`
    case 'date':
      return `@date ${value.value}`
    case 'ref':
      return `@ref ${value.target}`
    case 'blob':
      return `@blob ${value.hash}`
    case 'null':
      return `@null`
    default:
      return ''
  }
}

function isScalar(value: Value): boolean {
  return value.kind !== 'collection' && value.kind !== 'record'
}

function writeMultiline(name: string, textValue: string, depth: number, out: Array<string>): void {
  out.push(`${IND.repeat(depth)}${name} |`)
  for (const line of textValue.split('\n')) {
    out.push(`${IND.repeat(depth + 1)}${line}`)
  }
}

function writeField(name: string, value: Value, depth: number, out: Array<string>): void {
  const pad = IND.repeat(depth)
  if (value.kind === 'text' && value.value.includes('\n')) {
    writeMultiline(name, value.value, depth, out)
    return
  }
  if (isScalar(value)) {
    out.push(`${pad}${name} ${encodeScalar(value)}`.trimEnd())
    return
  }
  if (value.kind === 'record') {
    const r = value.record
    out.push(`${pad}${name} @record ${r.type}${r.label ? ` ${r.label}` : ''}`.trimEnd())
    writeBody(r, depth + 1, out)
    return
  }
  if (value.kind === 'collection') {
    out.push(`${pad}${name} @${value.order}`)
    for (const it of value.items) {
      writeItem(it, depth + 1, out)
    }
  }
}

function writeItem(it: Item, depth: number, out: Array<string>): void {
  const pad = IND.repeat(depth)
  const suffix = it.mark ? ` ^${it.mark}` : ''
  const keyPrefix = it.key !== undefined ? `${it.key}: ` : ''
  if (isScalar(it.value)) {
    out.push(`${pad}- ${keyPrefix}${encodeScalar(it.value)}${suffix}`.trimEnd())
    return
  }
  if (it.value.kind === 'record') {
    const r = it.value.record
    out.push(`${pad}- ${keyPrefix}@record ${r.type}${r.label ? ` ${r.label}` : ''}${suffix}`.trimEnd())
    writeBody(r, depth + 1, out)
    return
  }
  if (it.value.kind === 'collection') {
    out.push(`${pad}- ${keyPrefix}@${it.value.order}${suffix}`)
    for (const sub of it.value.items) {
      writeItem(sub, depth + 1, out)
    }
  }
}

// Write the mark then the sorted fields of a record.
function writeBody(node: RecordNode, depth: number, out: Array<string>): void {
  if (node.mark !== undefined) {
    out.push(`${IND.repeat(depth)}mark <${node.mark}>`)
  }
  for (const name of [...node.fields.keys()].sort()) {
    writeField(name, node.fields.get(name)!, depth, out)
  }
}

export function formatTree(node: RecordNode): string {
  const out: Array<string> = []
  out.push(`${node.type}${node.label ? ` ${node.label}` : ''}`)
  writeBody(node, 1, out)
  return out.join('\n') + '\n'
}
