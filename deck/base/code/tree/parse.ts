import type { CollectionKind, Item, RecordNode, Value } from '@term/base/code/base/type'

// Parse .tree text into a record graph. Mirrors the formatter, so format and parse
// round-trip. See note/library/base/02-tree-syntax.md.

// A line, plus the comments written above it. Comments are trivia in the text and
// content in the record: they attach to whatever they precede, so nothing an author
// wrote is lost on a round trip.
type Line = {
  indent: number
  text: string
  comments?: Array<string>
}

function toLines(text: string): Array<Line> {
  const out: Array<Line> = []
  let pending: Array<string> = []

  for (const raw of text.split('\n')) {
    if (raw.trim() === '') {
      continue
    }

    const spaces = raw.length - raw.replace(/^ +/, '').length
    const content = raw.slice(spaces)

    // a comment attaches to the next real line, the way a leading comment reads
    if (content.startsWith('#')) {
      pending.push(content.slice(1).replace(/^ /, ''))
      continue
    }

    const line: Line = {
      indent: Math.floor(spaces / 2),
      text: content,
    }

    if (pending.length > 0) {
      line.comments = pending
      pending = []
    }

    out.push(line)
  }

  return out
}

function parseScalar(s: string): Value {
  if (!s.startsWith('@')) {
    return { kind: 'text', value: s }
  }
  const sp = s.indexOf(' ')
  const tag = sp < 0 ? s : s.slice(0, sp)
  const arg = sp < 0 ? '' : s.slice(sp + 1)
  switch (tag) {
    case '@integer':
      return { kind: 'integer', value: BigInt(arg) }
    case '@decimal':
      return { kind: 'decimal', value: arg }
    case '@boolean':
      return { kind: 'boolean', value: arg === 'true' }
    case '@date':
      return { kind: 'date', value: arg }
    case '@ref':
      return { kind: 'ref', target: arg }
    case '@blob':
      return { kind: 'blob', hash: arg }
    case '@null':
      return { kind: 'null' }
    default:
      return { kind: 'text', value: s }
  }
}

const ORDERS: Array<string> = ['list', 'set', 'log', 'map']

class Cursor {
  i = 0
  constructor(readonly lines: Array<Line>) {}
  peek(): Line | undefined {
    return this.lines[this.i]
  }
}

// Parse the body (mark and fields) of a record whose children sit at `childIndent`.
function parseBody(
  c: Cursor,
  childIndent: number,
): {
  mark?: string
  fields: Map<string, Value>
  comments: Map<string, Array<string>>
} {
  const fields = new Map<string, Value>()
  // keyed by the field the comment sits above
  const comments = new Map<string, Array<string>>()
  let mark: string | undefined

  while (c.peek() && c.peek()!.indent === childIndent) {
    const entry = c.peek()!
    const line = entry.text

    if (line.startsWith('mark ')) {
      mark = line.slice(5).replace(/^<|>$/g, '')

      if (entry.comments) {
        comments.set('mark', entry.comments)
      }

      c.i++
      continue
    }

    const sp = line.indexOf(' ')
    const name = sp < 0 ? line : line.slice(0, sp)
    const rest = sp < 0 ? '' : line.slice(sp + 1)

    if (entry.comments) {
      comments.set(name, entry.comments)
    }

    c.i++
    fields.set(name, parseValue(c, rest, childIndent))
  }

  const out: {
    mark?: string
    fields: Map<string, Value>
    comments: Map<string, Array<string>>
  } = { fields, comments }

  if (mark !== undefined) {
    out.mark = mark
  }

  return out
}

// Parse a field value given the remainder of its line and the field's indent.
function parseValue(c: Cursor, rest: string, fieldIndent: number): Value {
  const childIndent = fieldIndent + 1
  if (rest === '|') {
    const parts: Array<string> = []
    while (c.peek() && c.peek()!.indent >= childIndent) {
      parts.push(c.peek()!.text)
      c.i++
    }
    return { kind: 'text', value: parts.join('\n') }
  }
  if (rest.startsWith('@record ')) {
    const [type, label] = splitTypeLabel(rest.slice('@record '.length))
    const body = parseBody(c, childIndent)
    return { kind: 'record', record: makeRecord(type, label, body) }
  }
  const orderTag = rest.startsWith('@') ? rest.slice(1) : ''
  if (ORDERS.includes(orderTag)) {
    return {
      kind: 'collection',
      order: orderTag as CollectionKind,
      items: parseItems(c, childIndent),
    }
  }
  return parseScalar(rest)
}

function parseItems(c: Cursor, itemIndent: number): Array<Item> {
  const items: Array<Item> = []
  while (
    c.peek() &&
    c.peek()!.indent === itemIndent &&
    c.peek()!.text.startsWith('- ')
  ) {
    let content = c.peek()!.text.slice(2)
    c.i++
    let mark: string | undefined
    const caret = content.lastIndexOf(' ^')
    if (caret >= 0) {
      mark = content.slice(caret + 2)
      content = content.slice(0, caret)
    }
    let key: string | undefined
    const colon = content.indexOf(': ')
    if (colon >= 0 && !content.startsWith('@')) {
      key = content.slice(0, colon)
      content = content.slice(colon + 2)
    }
    const value = parseItemValue(c, content, itemIndent)
    const it: Item = { value }
    if (mark !== undefined) {
      it.mark = mark
    }
    if (key !== undefined) {
      it.key = key
    }
    items.push(it)
  }
  return items
}

function parseItemValue(c: Cursor, content: string, itemIndent: number): Value {
  const childIndent = itemIndent + 1
  if (content.startsWith('@record ')) {
    const [type, label] = splitTypeLabel(content.slice('@record '.length))
    const body = parseBody(c, childIndent)
    return { kind: 'record', record: makeRecord(type, label, body) }
  }
  const orderTag = content.startsWith('@') ? content.slice(1) : ''
  if (ORDERS.includes(orderTag)) {
    return {
      kind: 'collection',
      order: orderTag as CollectionKind,
      items: parseItems(c, childIndent),
    }
  }
  return parseScalar(content)
}

function splitTypeLabel(s: string): [string, string | undefined] {
  const sp = s.indexOf(' ')
  return sp < 0 ? [s, undefined] : [s.slice(0, sp), s.slice(sp + 1)]
}

function makeRecord(
  type: string,
  label: string | undefined,
  body: {
    mark?: string
    fields: Map<string, Value>
    comments?: Map<string, Array<string>>
  },
  own?: Array<string>,
): RecordNode {
  const node: RecordNode = { type, fields: body.fields }

  if (body.mark !== undefined) {
    node.mark = body.mark
  }

  if (label !== undefined) {
    node.label = label
  }

  // the record's own leading comments live under the empty key, its fields' under
  // their own names
  const comments = new Map(body.comments ?? [])

  if (own && own.length > 0) {
    comments.set('', own)
  }

  if (comments.size > 0) {
    node.comments = comments
  }

  return node
}

export function parseTree(text: string): RecordNode {
  const c = new Cursor(toLines(text))
  const first = c.peek()
  if (!first) {
    throw new Error('empty .tree input')
  }
  const [type, label] = splitTypeLabel(first.text)
  c.i++
  const body = parseBody(c, 1)

  return makeRecord(type, label, body, first.comments)
}
