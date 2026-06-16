// The tree builder. The event stream to the syntax tree, using a stack of nesting frames. Each node attaches
// under the head of its line. Also the public parse entry and a printer for the canonical form. Browser-safe.

import type { Diagnostic, Span } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Token } from '@/code/parser/token'
import { tokenize } from '@/code/parser/token'
import type { Event } from '@/code/parser/event'
import { EventKind, buildEvents } from '@/code/parser/event'

export type RootNode = { kind: 'root'; nodes: Array<GroupNode> }
export type GroupNode = {
  kind: 'group'
  nodes: Array<GroupNode | NameNode | TextNode | IntegerNode | DecimalNode | RadixNode>
  parent?: GroupNode | InterpolationNode
  optional?: boolean
}
export type NameNode = { kind: 'name'; parts: Array<ChunkNode | InterpolationNode>; parent?: GroupNode }
export type TextNode = { kind: 'text'; parts: Array<ChunkNode | InterpolationNode>; parent?: GroupNode }
export type InterpolationNode = { kind: 'interpolation'; depth: number; group?: GroupNode; parent?: NameNode | TextNode }
export type ChunkNode = { kind: 'chunk'; text: string; token: Token; parent?: NameNode | TextNode }
export type IntegerNode = { kind: 'integer'; value: number; token: Token; parent?: GroupNode }
export type DecimalNode = { kind: 'decimal'; value: number; token: Token; parent?: GroupNode }
export type RadixNode = { kind: 'radix'; value: number; radix: number; token: Token; parent?: GroupNode }

export type Node =
  | RootNode
  | GroupNode
  | NameNode
  | TextNode
  | InterpolationNode
  | ChunkNode
  | IntegerNode
  | DecimalNode
  | RadixNode

export type ParseResult =
  | { ok: true; tree: RootNode }
  | { ok: false; diagnostics: Array<Diagnostic> }

type Frame = { line: Array<Node>; levels: Array<Node>; level: number }

function setParent(child: { parent?: unknown }, parent: unknown) {
  // non-enumerable so the tree can be serialized without circular references
  Object.defineProperty(child, 'parent', { value: parent, enumerable: false, writable: true })
}

function buildTree(events: Array<Event>, file: string, diagnostics: Array<Diagnostic>): RootNode {
  const root: RootNode = { kind: 'root', nodes: [] }
  const stack: Array<Frame> = [{ line: [root], levels: [root], level: 0 }]

  const top = () => stack[stack.length - 1]!
  const base = () => top().line[top().line.length - 1]!
  const lift = (frame: Frame, node: Node) => {
    if (frame.line.length === 2) {
      frame.levels = frame.levels.slice(0, frame.level + 1)
      frame.levels.push(node)
    }
  }
  const unexpected = (event: Event) => {
    const token = 'token' in event ? (event.token as Token) : undefined
    diagnostics.push(diagnose('unexpected-node', { file, span: token ? token.span : zeroSpan(), message: `unexpected ${event.kind} here` }))
  }

  for (const event of events) {
    switch (event.kind) {
      case EventKind.OpenGroup: {
        const here = base()
        if (here.kind === 'root' || here.kind === 'group') {
          const group: GroupNode = { kind: 'group', nodes: [] }
          here.nodes.push(group)
          setParent(group, here)
          top().line.push(group)
          lift(top(), group)
        } else if (here.kind === 'interpolation') {
          const group: GroupNode = { kind: 'group', nodes: [] }
          here.group = group
          setParent(group, here)
          top().line.push(group)
          lift(top(), group)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.CloseGroup:
      case EventKind.CloseName:
      case EventKind.CloseText:
        top().line.pop()
        break
      case EventKind.OpenName: {
        const here = base()
        if (here.kind === 'group') {
          const name: NameNode = { kind: 'name', parts: [] }
          here.nodes.push(name)
          setParent(name, here)
          top().line.push(name)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.OpenText: {
        const here = base()
        if (here.kind === 'group') {
          const text: TextNode = { kind: 'text', parts: [] }
          here.nodes.push(text)
          setParent(text, here)
          top().line.push(text)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.OpenInterpolation: {
        const here = base()
        if (here.kind === 'name' || here.kind === 'text') {
          const interpolation: InterpolationNode = { kind: 'interpolation', depth: event.depth }
          here.parts.push(interpolation)
          setParent(interpolation, here)
          stack.push({ line: [interpolation], levels: [interpolation], level: 0 })
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.CloseInterpolation:
        stack.pop()
        break
      case EventKind.Chunk: {
        const here = base()
        if (here.kind === 'name') {
          const text = event.token.text
          const optional = text.includes('?')
          const chunk: ChunkNode = { kind: 'chunk', text: optional ? text.replace(/\?/g, '') : text, token: event.token }
          here.parts.push(chunk)
          setParent(chunk, here)
          if (optional && here.parent) here.parent.optional = true
        } else if (here.kind === 'text') {
          const chunk: ChunkNode = { kind: 'chunk', text: event.token.text, token: event.token }
          here.parts.push(chunk)
          setParent(chunk, here)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.Integer: {
        const here = base()
        if (here.kind === 'group') {
          const node: IntegerNode = { kind: 'integer', value: event.value, token: event.token }
          here.nodes.push(node)
          setParent(node, here)
        } else if (here.kind === 'root') {
          diagnostics.push(
            diagnose('invalid-nesting', {
              file,
              span: event.token.span,
              hint: 'a bare number is a value, not a name, so it cannot be the head of a line',
            }),
          )
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.Decimal: {
        const here = base()
        if (here.kind === 'group') {
          const node: DecimalNode = { kind: 'decimal', value: event.value, token: event.token }
          here.nodes.push(node)
          setParent(node, here)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.Radix: {
        const here = base()
        if (here.kind === 'group') {
          const node: RadixNode = { kind: 'radix', value: event.value, radix: event.radix, token: event.token }
          here.nodes.push(node)
          setParent(node, here)
        } else {
          unexpected(event)
        }
        break
      }
      case EventKind.OpenIndent: {
        const frame = top()
        frame.level++
        frame.line = [frame.levels[frame.level]!]
        break
      }
      case EventKind.CloseIndent: {
        const frame = top()
        frame.level--
        frame.line = [frame.levels[frame.level]!]
        break
      }
      default:
        break
    }
  }

  return root
}

function zeroSpan(): Span {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
}

// The strict entry. Parse text to a tree, or return diagnostics.
export function parse(source: { file: string; text: string }): ParseResult {
  const tokenResult = tokenize(source)
  if (!tokenResult.ok) return { ok: false, diagnostics: tokenResult.diagnostics }

  const eventResult = buildEvents(tokenResult.tokens)
  if (!eventResult.ok) return { ok: false, diagnostics: eventResult.diagnostics }

  const diagnostics: Array<Diagnostic> = []
  const tree = buildTree(eventResult.stream.events, source.file, diagnostics)
  if (diagnostics.length) return { ok: false, diagnostics }
  return { ok: true, tree }
}

// The tolerant entry. Never fails. Returns whatever tree it built plus any diagnostics. For the language server.
export function parseTolerant(source: { file: string; text: string }): { tree: RootNode; diagnostics: Array<Diagnostic> } {
  const empty: RootNode = { kind: 'root', nodes: [] }
  const tokenResult = tokenize(source)
  if (!tokenResult.ok) return { tree: empty, diagnostics: tokenResult.diagnostics }
  const eventResult = buildEvents(tokenResult.tokens)
  if (!eventResult.ok) return { tree: empty, diagnostics: eventResult.diagnostics }
  const diagnostics: Array<Diagnostic> = []
  const tree = buildTree(eventResult.stream.events, source.file, diagnostics)
  return { tree, diagnostics }
}

// Render a name or text node inline (e.g. inside interpolation or as a head value).
function renderParts(parts: Array<ChunkNode | InterpolationNode>): string {
  let out = ''
  for (const part of parts) {
    if (part.kind === 'chunk') out += part.text
    else out += `${'{'.repeat(part.depth)}${part.group ? renderInline(part.group) : ''}${'}'.repeat(part.depth)}`
  }
  return out
}

// Render a group in inline parenthesized form: a(b, c). Used inside interpolation.
function renderInline(group: GroupNode): string {
  const [head, ...rest] = group.nodes
  const headText = head ? renderHead(head) : ''
  if (rest.length === 0) return headText
  return `${headText}(${rest.map((n) => (n.kind === 'group' ? renderInline(n) : renderHead(n))).join(', ')})`
}

function renderHead(node: Node): string {
  switch (node.kind) {
    case 'name':
      return renderParts(node.parts)
    case 'text':
      return `<${renderParts(node.parts)}>`
    case 'integer':
      return String(node.value)
    case 'decimal':
      return String(node.value)
    case 'radix':
      return node.token.text
    case 'group':
      return renderInline(node)
    default:
      return ''
  }
}

// Print the canonical expanded form: one node per line, children indented two spaces.
export function printTree(tree: RootNode): string {
  const lines: Array<string> = []
  const walk = (group: GroupNode, depth: number) => {
    const [head, ...rest] = group.nodes
    const indent = '  '.repeat(depth)
    lines.push(`${indent}${head ? renderHead(head) : ''}${group.optional ? '?' : ''}`)
    for (const child of rest) {
      if (child.kind === 'group') walk(child, depth + 1)
      else lines.push(`${'  '.repeat(depth + 1)}${renderHead(child)}`)
    }
  }
  for (const group of tree.nodes) walk(group, 0)
  return lines.join('\n')
}
