import type { Item, RecordNode, Value } from '@term/base/code/base/type'
import { normalizeDecimal } from '@term/base/code/canon/canonicalize'

// Render a record graph to canonical .tree text: the readable authoring syntax.
// A record is `type label`; the mark comes first; scalars are `name value` (typed
// values use an @marker); nested records use `@record`; collections use `@list`,
// `@set`, `@log`, or `@map` with `-` items. This is a projection of the record, so
// it round-trips with the parser.
//
// See note/library/base/02-tree-syntax.md.

const IND = '  '

// A bare text value is emitted verbatim, but some strings would re-parse as
// something else: one beginning with `@` reads as a typed marker (`@integer`,
// `@list`, `@record`, ...), a lone `|` opens a multi-line block, and inside a
// collection item ` ^` reads as a mark and `: ` as a key. Any of those is written
// with an explicit `@text ` prefix, which the parser strips back to the literal
// string, so every string round-trips. (Multi-line text keeps the readable `|`
// block; this covers single-line values only.)
function textNeedsTag(value: string, inItem: boolean): boolean {
  if (value.startsWith('@') || value === '|') {
    return true
  }
  if (inItem && (value.includes(' ^') || value.includes(': '))) {
    return true
  }
  return false
}

function encodeText(value: string, inItem: boolean): string {
  return textNeedsTag(value, inItem) ? `@text ${value}` : value
}

function encodeScalar(value: Value, inItem = false): string {
  switch (value.kind) {
    case 'text':
      return encodeText(value.value, inItem)
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
    out.push(`${pad}- ${keyPrefix}${encodeScalar(it.value, true)}${suffix}`.trimEnd())
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
// Emit the comments attached to `key`, above the line they belong to. Position is
// canonical, like everything else the formatter writes: a comment sits directly above
// what it annotates, at that thing's indentation.
function writeComments(
  node: RecordNode,
  key: string,
  depth: number,
  out: Array<string>,
): void {
  const lines = node.comments?.get(key)

  if (!lines) {
    return
  }

  for (const line of lines) {
    out.push(line ? `${IND.repeat(depth)}# ${line}` : `${IND.repeat(depth)}#`)
  }
}

function writeBody(node: RecordNode, depth: number, out: Array<string>): void {
  if (node.mark !== undefined) {
    writeComments(node, 'mark', depth, out)
    out.push(`${IND.repeat(depth)}mark <${node.mark}>`)
  }

  for (const name of [...node.fields.keys()].sort()) {
    writeComments(node, name, depth, out)
    writeField(name, node.fields.get(name)!, depth, out)
  }
}

export function formatTree(node: RecordNode): string {
  const out: Array<string> = []

  // the record's own leading comments sit above its head line, at column zero
  writeComments(node, '', 0, out)

  out.push(`${node.type}${node.label ? ` ${node.label}` : ''}`)
  writeBody(node, 1, out)

  return out.join('\n') + '\n'
}
