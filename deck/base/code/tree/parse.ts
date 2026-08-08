import type { CollectionKind, Item, RecordNode, Value } from '@term/base/code/base/type'

// Parse .tree text into a record graph. Mirrors the formatter, so format and parse
// round-trip. See note/library/base/02-tree-syntax.md.

// The deepest a .tree may nest. A hostile or accidental deeply-indented input
// would otherwise recurse to the call-stack limit and crash the process; past this
// a catchable parse error is thrown instead. Real authored content nests a handful
// of levels, far below this.
const MAX_TREE_DEPTH = 512

// A line, plus the comments written above it. Comments are trivia in the text and
// content in the record: they attach to whatever they precede, so nothing an author
// wrote is lost on a round trip. A multi-line text field owns the verbatim `block`
// of lines beneath it, captured here (comments and blank lines inside a block are
// content, not trivia, so they must bypass comment/blank stripping).
type Line = {
  indent: number
  text: string
  comments?: Array<string>
  block?: Array<string>
}

function leadingSpaces(raw: string): number {
  return raw.length - raw.replace(/^ +/, '').length
}

function toLines(text: string): Array<Line> {
  const rawLines = text.split('\n')
  const out: Array<Line> = []
  let pending: Array<string> = []
  let i = 0

  while (i < rawLines.length) {
    const raw = rawLines[i]!
    if (raw.trim() === '') {
      i++
      continue
    }

    const spaces = leadingSpaces(raw)
    const content = raw.slice(spaces)

    // a comment attaches to the next real line, the way a leading comment reads
    if (content.startsWith('#')) {
      pending.push(content.slice(1).replace(/^ /, ''))
      i++
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

    // A `<name> |` field owns the more-indented lines that follow as its verbatim
    // multi-line text. They are captured here, stripped of only the block's own
    // base indentation (so inner indentation survives), WITHOUT the comment/blank
    // filtering above — a `#` heading or a blank line inside a guide body is
    // content, and stripping it silently corrupted the text.
    if (/^\S+ \|$/.test(content)) {
      const base = spaces + 2
      const block: Array<string> = []
      let blanks: Array<string> = []
      i++
      while (i < rawLines.length) {
        const bl = rawLines[i]!
        if (bl.trim() === '') {
          blanks.push('')
          i++
          continue
        }
        if (leadingSpaces(bl) >= base) {
          // a blank line is block content only when more block follows it; a run
          // of blanks trailing the block is dropped (it is layout, not text)
          for (let k = 0; k < blanks.length; k++) {
            block.push('')
          }
          blanks = []
          block.push(bl.slice(base))
          i++
        } else {
          break
        }
      }
      line.block = block
      out.push(line)
      continue
    }

    out.push(line)
    i++
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
    case '@text':
      // the escape for any text that would otherwise re-parse as a marker, a
      // block, an item mark, or an item key: the argument is the literal text
      return { kind: 'text', value: arg }
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

function checkDepth(depth: number): void {
  if (depth > MAX_TREE_DEPTH) {
    throw new Error('.tree nesting is too deep')
  }
}

// Parse the body (mark and fields) of a record whose children sit at `childIndent`.
function parseBody(
  c: Cursor,
  childIndent: number,
  depth: number,
): {
  mark?: string
  fields: Map<string, Value>
  comments: Map<string, Array<string>>
} {
  checkDepth(depth)
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
    fields.set(name, parseValue(c, rest, childIndent, depth + 1, entry.block))
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
function parseValue(
  c: Cursor,
  rest: string,
  fieldIndent: number,
  depth: number,
  block?: Array<string>,
): Value {
  checkDepth(depth)
  const childIndent = fieldIndent + 1
  if (rest === '|') {
    // the multi-line block was captured verbatim by toLines
    return { kind: 'text', value: (block ?? []).join('\n') }
  }
  if (rest.startsWith('@record ')) {
    const [type, label] = splitTypeLabel(rest.slice('@record '.length))
    const body = parseBody(c, childIndent, depth + 1)
    return { kind: 'record', record: makeRecord(type, label, body) }
  }
  const orderTag = rest.startsWith('@') ? rest.slice(1) : ''
  if (ORDERS.includes(orderTag)) {
    return {
      kind: 'collection',
      order: orderTag as CollectionKind,
      items: parseItems(c, childIndent, depth + 1),
    }
  }
  return parseScalar(rest)
}

function parseItems(
  c: Cursor,
  itemIndent: number,
  depth: number,
): Array<Item> {
  checkDepth(depth)
  const items: Array<Item> = []
  while (
    c.peek() &&
    c.peek()!.indent === itemIndent &&
    c.peek()!.text.startsWith('- ')
  ) {
    let content = c.peek()!.text.slice(2)
    c.i++

    // key first (before mark), only when the value is not an escaped @text (whose
    // literal content may itself contain `: `)
    let key: string | undefined
    const colon = content.indexOf(': ')
    if (colon >= 0 && !content.startsWith('@')) {
      key = content.slice(0, colon)
      content = content.slice(colon + 2)
    }

    // a mark is the trailing ` ^<mark>`. An escaped @text value is literal — its
    // content may end in ` ^...` that is NOT a mark — so mark parsing is skipped
    // for it (a mark on an item whose text needs escaping is not represented).
    let mark: string | undefined
    if (!content.startsWith('@text ')) {
      const caret = content.lastIndexOf(' ^')
      if (caret >= 0) {
        mark = content.slice(caret + 2)
        content = content.slice(0, caret)
      }
    }

    const value = parseItemValue(c, content, itemIndent, depth + 1)
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

function parseItemValue(
  c: Cursor,
  content: string,
  itemIndent: number,
  depth: number,
): Value {
  checkDepth(depth)
  const childIndent = itemIndent + 1
  if (content.startsWith('@record ')) {
    const [type, label] = splitTypeLabel(content.slice('@record '.length))
    const body = parseBody(c, childIndent, depth + 1)
    return { kind: 'record', record: makeRecord(type, label, body) }
  }
  const orderTag = content.startsWith('@') ? content.slice(1) : ''
  if (ORDERS.includes(orderTag)) {
    return {
      kind: 'collection',
      order: orderTag as CollectionKind,
      items: parseItems(c, childIndent, depth + 1),
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
  const body = parseBody(c, 1, 0)

  return makeRecord(type, label, body, first.comments)
}
