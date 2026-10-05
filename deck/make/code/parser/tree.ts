// The tree builder. The event stream to the syntax tree, using a stack of nesting frames. Each node attaches
// under the head of its line. Also the public parse entry and a printer for the canonical form. Browser-safe.

import type {
  Diagnostic,
  Span,
} from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import { rawContent, tokenize } from '@term/make/code/parser/token'
import type { CommaAfterLeaf, Event, Follows } from '@term/make/code/parser/event'
import { buildEvents } from '@term/make/code/parser/event'
import type {
  ChunkNode,
  DecimalNode,
  GroupNode,
  IntegerNode,
  InterpolationNode,
  NameNode,
  RadixNode,
  TextNode,
} from '@term/make/code/parser/narrow'

// A node holds no link to its parent and no token: what a reader wants of the token is carried on the node (its
// `span`, its `text` as written, and for a name's chunk what `follows` it), so the tree is plain data and a Term
// record can hold it.
// CST trivia: a comment written on a line above a node
export type Comment = { text: string; span: Span }

// the top of a parsed file, which is no other node's child, so it stands apart from the union
export type RootNode = { kind: 'root'; nodes: Node[] }

// One union, the shape parser/tree.tree's `node` form emits: a Term form cannot hold a list of some of its cases, so a
// group's `nodes`, a name's `parts` and an interpolation's `group` are typed `Node`, and a reader narrows on `kind`
export type Node =
  // `comments`: CST trivia, the comments written on the lines above this group. The formatter re-emits them; lint
  // reads suppressions. This is what makes the tree a concrete syntax tree rather than a bare AST.
  | { kind: 'group'; nodes: Node[]; optional?: boolean; comments?: Comment[] }
  | { kind: 'name'; parts: Node[] }
  // `raw`: a RAW literal (`<<...>>`, token.ts) as it was written. Its parts are the one chunk an ordinary literal would
  // carry for the same text, so every reader sees an ordinary literal, and a printer writes this back between `<<` and
  // `>>`
  | { kind: 'text'; parts: Node[]; raw?: string; comments?: Comment[] }
  // `call`: the root of a path written after a call, `greeting()/text`, with no braces (buildTree)
  | { kind: 'interpolation'; depth: number; group?: Node; call?: boolean }
  // `text`: in a name, without the optional mark `?`. `follows`: in a name, what its token is followed by, `(`
  // (`f(a)`) or `()` (`f()`)
  | { kind: 'chunk'; text: string; span: Span; follows?: Follows }
  // `text`: the literal as written (`2,440,588`, and `1.0`, which is not `String(1)`)
  | { kind: 'integer'; value: number; text: string; span: Span; comments?: Comment[] }
  | { kind: 'decimal'; value: number; text: string; span: Span; comments?: Comment[] }
  | { kind: 'radix'; value: number; text: string; span: Span; comments?: Comment[]; radix: number }

// `ok` when the text parsed with no diagnostic. Every field is there either way, so a Term record holds it: a failed
// parse carries an empty tree, and a good one no diagnostics
export type ParseResult = { ok: boolean; tree: RootNode; diagnostics: Diagnostic[] }

// a line and the levels of nesting it stands at, by the node each opened: the root is one, though it is no Node
type Frame = { line: (Node | RootNode)[]; levels: (Node | RootNode)[]; level: number }

function buildTree(
  events: Event[],
  file: string,
  diagnostics: Diagnostic[],
): RootNode {
  const root: RootNode = { kind: 'root', nodes: [] }
  const stack: Frame[] = [{ line: [root], levels: [root], level: 0 }]

  // a sentinel frame for the same reason VOID_NODE exists below: malformed input can close more frames than it
  // opened, and `top()` returning undefined turned that into a TypeError instead of a diagnostic. Every read
  // through the sentinel yields VOID_NODE, which matches no real node kind, so the event lands in
  // `unexpected(event)`.
  const VOID_FRAME: Frame = { line: [], levels: [], level: 0 }
  const top = () => stack[stack.length - 1] ?? VOID_FRAME
  // a sentinel returned when the current line has underflowed (e.g. a
  // statement indented with no parent, or more closes than opens). Its
  // `kind` matches none of the real node kinds, so every `here.kind`
  // check below falls through to `unexpected(event)` and emits a
  // diagnostic instead of dereferencing undefined (which used to crash).
  const VOID_NODE = { kind: 'void' } as unknown as Node
  const base = () => top().line[top().line.length - 1] ?? VOID_NODE

  const lift = (frame: Frame, node: Node) => {
    if (frame.line.length === 2) {
      // truncate in place instead of reallocating the levels array each
      // group-open: the slice made buildTree O(depth^2) in nesting depth.
      frame.levels.length = frame.level + 1
      frame.levels.push(node)
    }
  }

  const unexpected = (event: Event) => {
    diagnostics.push(
      diagnose('unexpected-node', {
        file,
        span: 'span' in event ? event.span : zeroSpan(),
        // a content event is named for what it read (`read-chunk`), and the message names the thing (`chunk`)
        message: `unexpected ${event.kind.replace(/^read-/, '')} here`,
      }),
    )
  }

  // comments seen since the last group; attached as leading trivia to the next group opened (CST)
  let pendingComments: Comment[] = []

  // the event before this one, so a path chunk can tell that it follows a call's closing parenthesis directly
  let previous: Event | undefined

  for (let at = 0; at < events.length; at++) {
    const event = events[at]!
    const before = previous
    previous = event

    switch (event.kind) {
      case 'read-comment':
        pendingComments.push({
          text: event.text,
          span: event.span,
        })
        break

      case 'open-group': {
        const here = base()

        if (here.kind === 'root' || here.kind === 'group') {
          const group: GroupNode = { kind: 'group', nodes: [] }

          if (pendingComments.length > 0) {
            group.comments = pendingComments
            pendingComments = []
          }

          here.nodes.push(group)
          top().line.push(group)
          lift(top(), group)
        } else if (here.kind === 'interpolation') {
          const group: GroupNode = { kind: 'group', nodes: [] }
          here.group = group
          top().line.push(group)
          lift(top(), group)
        } else {
          unexpected(event)
        }

        break
      }

      case 'close-group':
      case 'close-name':
      case 'close-text': {
        // more closes than opens: the event stream underflowed on malformed input. Report it rather than
        // dereferencing an empty stack — a parser must produce a diagnostic, never throw. `base()` already has
        // the same guard through VOID_NODE; this path did not, and crashed with a TypeError instead.
        const frame = stack[stack.length - 1]

        if (!frame) {
          unexpected(event)
          break
        }

        frame.line.pop()
        break
      }

      case 'open-name': {
        const here = base()

        if (here.kind === 'group') {
          const name: NameNode = { kind: 'name', parts: [] }
          here.nodes.push(name)
          top().line.push(name)
        } else {
          unexpected(event)
        }

        break
      }

      case 'open-text': {
        const here = base()

        if (here.kind === 'group') {
          const text: TextNode = { kind: 'text', parts: [] }

          // a raw literal opens with `<<`, and its content is the one chunk after it, or nothing
          if (event.text === '<<') {
            const next = events[at + 1]
            text.raw = next?.kind === 'read-chunk' ? rawContent(next.text) : ''
          }

          if (pendingComments.length > 0) {
            text.comments = pendingComments
            pendingComments = []
          }

          here.nodes.push(text)
          top().line.push(text)
        } else {
          unexpected(event)
        }

        break
      }

      case 'open-interpolation': {
        const here = base()

        if (here.kind === 'name' || here.kind === 'text') {
          const interpolation: InterpolationNode = {
            kind: 'interpolation',
            depth: event.depth,
          }

          here.parts.push(interpolation)
          stack.push({
            line: [interpolation],
            levels: [interpolation],
            level: 0,
          })
        } else if (here.kind === 'group') {
          // a BARE `{x}` where a value goes, `is-equal(value, {tag})`: after a comma or an opening parenthesis the
          // events carry no name around the braces, which `log {tag}` gets. It is that same name, so a template
          // hole stands for a value anywhere. Without this the close below popped a frame it never pushed, and
          // one brace became dozens of errors at line 1.
          const interpolation: InterpolationNode = {
            kind: 'interpolation',
            depth: event.depth,
          }
          const name: NameNode = { kind: 'name', parts: [interpolation] }
          const group: GroupNode = { kind: 'group', nodes: [name] }

          here.nodes.push(group)
          stack.push({
            line: [interpolation],
            levels: [interpolation],
            level: 0,
          })
        } else {
          unexpected(event)
        }

        break
      }

      case 'close-interpolation':
        stack.pop()
        break

      case 'read-chunk': {
        const here = base()

        if (here.kind === 'name') {
          const optional = event.text.includes('?')

          here.parts.push(chunkOf(event, optional ? event.text.replace(/\?/g, '') : event.text))

          // the group the name opened in stands just under it on the line
          const owner = top().line.at(-2)

          if (optional && owner?.kind === 'group') {
            owner.optional = true
          }
        } else if (here.kind === 'text') {
          here.parts.push(chunkOf(event, event.text))
        } else if (
          here.kind === 'group' &&
          before?.kind === 'close-group' &&
          event.text.startsWith('/') &&
          here.nodes.at(-1)?.kind === 'group'
        ) {
          // a PATH AFTER A CALL, `greeting()/text`: the call just closed, and the chunk touching its parenthesis
          // reads a field of what it returns. It is the same name `{greeting()}/text` builds, an interpolated
          // segment rooted at the call, so every reader after this one sees a path it already reads. `call`
          // makes the printer write it back the way it was written.
          const call = here.nodes.pop() as GroupNode
          const head = pathAfterCall(call, chunkOf(event, event.text))
          here.nodes.push(head)

          // a comma later on the line pops back to a level, and the call may be one: the path stands there now
          const levels = top().levels
          const at = levels.indexOf(call)

          if (at >= 0) {
            levels[at] = head
          }
        } else if (
          here.kind === 'group' &&
          before?.kind === 'close-interpolation' &&
          event.text.startsWith('/') &&
          bareBraces(here.nodes.at(-1))
        ) {
          // a path after bare braces, `f(a, {k}/x)`: the rest of the name the braces opened
          const name = (here.nodes.at(-1) as GroupNode).nodes[0] as NameNode
          name.parts.push(chunkOf(event, event.text))
        } else if (
          here.kind === 'interpolation' &&
          here.group &&
          before?.kind === 'close-group' &&
          event.text.startsWith('/')
        ) {
          // the same path inside a text's braces, `<{greeting()/text}>`, where the call is the braces' one group
          const head = pathAfterCall(here.group, chunkOf(event, event.text))
          here.group = head
        } else {
          unexpected(event)
        }

        break
      }

      case 'read-integer': {
        const here = base()

        if (here.kind === 'group') {
          const node: IntegerNode = {
            kind: 'integer',
            value: event.value,
            text: event.text,
            span: event.span,
          }

          if (pendingComments.length > 0) {
            node.comments = pendingComments
            pendingComments = []
          }

          here.nodes.push(node)
        } else if (here.kind === 'root') {
          diagnostics.push(
            diagnose('invalid-nesting', {
              file,
              span: event.span,
              hint: 'a bare number is a value, not a name, so it cannot be the head of a line',
            }),
          )
        } else {
          unexpected(event)
        }

        break
      }

      case 'read-decimal': {
        const here = base()

        if (here.kind === 'group') {
          const node: DecimalNode = {
            kind: 'decimal',
            value: event.value,
            text: event.text,
            span: event.span,
          }

          if (pendingComments.length > 0) {
            node.comments = pendingComments
            pendingComments = []
          }

          here.nodes.push(node)
        } else if (here.kind === 'root') {
          // the same mistake an INTEGER head makes, and it deserves the same sentence. It used to fall through to
          // `unexpected(event)` and say only "unexpected decimal here", which names the token kind and not the problem.
          diagnostics.push(
            diagnose('invalid-nesting', {
              file,
              span: event.span,
              hint: 'a bare number is a value, not a name, so it cannot be the head of a line',
            }),
          )
        } else {
          unexpected(event)
        }

        break
      }

      case 'read-radix': {
        const here = base()

        if (here.kind === 'group') {
          const node: RadixNode = {
            kind: 'radix',
            value: event.value,
            radix: event.radix,
            text: event.text,
            span: event.span,
          }

          if (pendingComments.length > 0) {
            node.comments = pendingComments
            pendingComments = []
          }

          here.nodes.push(node)
        } else if (here.kind === 'root') {
          // the same mistake an INTEGER head makes, and it deserves the same sentence. It used to fall through to
          // `unexpected(event)` and say only "unexpected radix here", which names the token kind and not the problem.
          diagnostics.push(
            diagnose('invalid-nesting', {
              file,
              span: event.span,
              hint: 'a bare number is a value, not a name, so it cannot be the head of a line',
            }),
          )
        } else {
          unexpected(event)
        }

        break
      }

      case 'open-indent': {
        const frame = top()
        frame.level++
        frame.line = [frame.levels[frame.level]!]
        break
      }

      case 'close-indent': {
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

// a group holding one name that is a run of braces, the shape a bare `{x}` builds where a value goes
function bareBraces(node: Node | undefined): boolean {
  if (node?.kind !== 'group' || node.nodes.length !== 1) {
    return false
  }

  const name = node.nodes[0]
  return name?.kind === 'name' && name.parts.at(-1)?.kind === 'interpolation'
}

// `greeting()/text` as the name `{greeting()}/text`: a group holding one name, whose parts are the call in braces
// and the path chunk
function pathAfterCall(call: Node, chunk: ChunkNode): GroupNode {
  const interpolation: InterpolationNode = { kind: 'interpolation', depth: 1, group: call, call: true }
  const name: NameNode = { kind: 'name', parts: [interpolation, chunk] }

  return { kind: 'group', nodes: [name] }
}

// a chunk node from its event, holding `text`, with what follows it when the event says
function chunkOf(event: { span: Span; follows?: Follows }, text: string): ChunkNode {
  return event.follows ? { kind: 'chunk', text, span: event.span, follows: event.follows } : { kind: 'chunk', text, span: event.span }
}

function zeroSpan(): Span {
  return { start: { line: 0, column: 0 }, end: { line: 0, column: 0 } }
}

// The strict entry. Parse text to a tree, or say why not: a failed parse's tree is empty. `afterLeaf` is the comma
// rule (event.ts), the grammar's unless a migration asks for another.
export function parse(source: { file: string; text: string }, afterLeaf: CommaAfterLeaf = 'stays'): ParseResult {
  const tolerant = parseTolerant(source, afterLeaf)

  if (tolerant.diagnostics.length > 0) {
    return { ok: false, tree: { kind: 'root', nodes: [] }, diagnostics: tolerant.diagnostics }
  }

  return { ok: true, tree: tolerant.tree, diagnostics: [] }
}

// The tolerant entry. Never fails. Returns whatever tree it built plus any diagnostics. For the language server. A
// text that does not lex, or does not nest, gives an empty tree: only the last stage builds past a mistake.
export function parseTolerant(
  source: { file: string; text: string },
  afterLeaf: CommaAfterLeaf = 'stays',
): {
  tree: RootNode
  diagnostics: Diagnostic[]
} {
  const empty: RootNode = { kind: 'root', nodes: [] }
  const tokenResult = tokenize(source)

  if (tokenResult.diagnostics.length > 0) {
    return { tree: empty, diagnostics: tokenResult.diagnostics }
  }

  const eventResult = buildEvents(tokenResult.tokens, afterLeaf)

  if (eventResult.diagnostics.length > 0) {
    return { tree: empty, diagnostics: eventResult.diagnostics }
  }

  const diagnostics: Diagnostic[] = []
  const tree = buildTree(eventResult.events, source.file, diagnostics)

  return { tree, diagnostics }
}

// Render a name or text node inline (e.g. inside interpolation or as a head value).
// A text literal's chunks, re-escaped for printing.
//
// Inside a literal, angles BALANCE: `<a <b> c>` is legal and its inner angles are content, which is why the
// tokenizer leaves them bare in the chunk. Escaping those would change the text's VALUE, so they are left alone.
// What must be escaped is an angle that does NOT balance — the tokenizer unescapes the `\<` that opens a
// literal's content, so `text <\<!doctype html\>>` gives a chunk starting with a bare `<` with no partner, and
// printing it raw yields `<<!doctype html\>>`, which reads as a nested bracket and no longer parses.
//
// Balance is computed across the WHOLE literal, not per chunk. A literal is split into several chunk nodes
// wherever an interpolation interrupts it, and a chunk holding only the `<` of a matched pair looks unbalanced
// on its own: doing this per chunk escaped the balanced angles in `<std::sync::Arc<...AtomicBool>>` and changed
// the module name the mill recorded.
//
// A backslash and the character after it are copied through untouched. Escaping an angle that already carries
// one doubles it, which is how an earlier attempt took the round-trip failures from 12 to 83.
//
// And an angle that opens the CONTENT is escaped with its partner, balanced or not: printed bare after the literal's
// own `<` it would read as `<<`, which opens a raw literal (token.ts), so `<\<x\>>` would come back as `<<x>>`, the
// raw text `x`.
export function escapeTextChunks(chunks: string[]): string[] {
  const escape = chunks.map(() => new Set<number>())
  const opens: { part: number; at: number }[] = []
  const leads = chunks.findIndex(text => text.length > 0)

  chunks.forEach((text, part) => {
    for (let i = 0; i < text.length; i++) {
      const c = text[i]!

      if (c === '\\' && i + 1 < text.length) {
        i++
        continue
      }

      if (c === '<') {
        opens.push({ part, at: i })
      } else if (c === '>') {
        const open = opens.pop()

        if (!open) {
          escape[part]!.add(i)
        } else if (open.part === leads && open.at === 0) {
          escape[open.part]!.add(0)
          escape[part]!.add(i)
        }
      }
    }
  })

  for (const open of opens) {
    escape[open.part]!.add(open.at)
  }

  return chunks.map((text, part) => {
    const marks = escape[part]!

    if (marks.size === 0) {
      return text
    }

    let out = ''

    for (let i = 0; i < text.length; i++) {
      const c = text[i]!

      if (c === '\\' && i + 1 < text.length) {
        out += text.slice(i, i + 2)
        i++
        continue
      }

      out += marks.has(i) ? `\\${c}` : c
    }

    return out
  })
}

function renderParts(parts: Node[], escape = false): string {
  let out = ''
  const escaped = escape
    ? escapeTextChunks(parts.filter((p): p is ChunkNode => p.kind === 'chunk').map(p => p.text))
    : []
  let chunkAt = 0

  for (const part of parts) {
    if (part.kind === 'chunk') {
      out += escape ? escaped[chunkAt++]! : part.text
    } else if (part.kind !== 'interpolation') {
      continue
    } else if (part.call && part.group) {
      out += part.group.kind === 'group' && part.group.nodes.length > 1 ? renderInline(part.group) : `${renderInline(part.group)}()`
    } else {
      out += `${'{'.repeat(part.depth)}${
        part.group ? renderInline(part.group) : ''
      }${'}'.repeat(part.depth)}`
    }
  }

  return out
}

// Render a group in inline parenthesized form: a(b, c). Used inside interpolation. Any other node is its head.
function renderInline(group: Node): string {
  if (group.kind !== 'group') {
    return renderHead(group)
  }

  const [head, ...rest] = group.nodes
  const headText = head ? renderHead(head) : ''

  if (rest.length === 0) {
    return headText
  }

  return `${headText}(${rest
    .map(n => (n.kind === 'group' ? renderInline(n) : renderHead(n)))
    .join(', ')})`
}

// one node as source text. Exported so a migration can re-emit a parsed line without reimplementing how a
// name, text literal, number or inline group is spelled.
export function renderHead(node: Node): string {
  switch (node.kind) {
    case 'name':
      return renderParts(node.parts)
    case 'text':
      return node.raw !== undefined ? `<<${node.raw}>>` : `<${renderParts(node.parts, true)}>`
    case 'integer':
      return String(node.value)
    // the text AS WRITTEN, not the value: `String(1.0)` is `"1"`, which re-reads as an INTEGER and silently changes
    // the type (`like decimal` becomes `like number`, and Rust then refuses to multiply a float by an integer).
    // `radix` prints its text for the same reason.
    case 'decimal':
      return node.text
    case 'radix':
      return node.text
    case 'group':
      return renderInline(node)
    default:
      return ''
  }
}

// Print the canonical expanded form: one node per line, children indented two spaces.
export function printTree(tree: RootNode): string {
  const lines: string[] = []

  const walk = (group: GroupNode, depth: number) => {
    const [head, ...rest] = group.nodes
    const indent = '  '.repeat(depth)
    lines.push(
      `${indent}${head ? renderHead(head) : ''}${
        group.optional ? '?' : ''
      }`,
    )

    for (const child of rest) {
      if (child.kind === 'group') {
        walk(child, depth + 1)
      } else {
        lines.push(`${'  '.repeat(depth + 1)}${renderHead(child)}`)
      }
    }
  }

  for (const group of tree.nodes) {
    if (group.kind === 'group') {
      walk(group, 0)
    }
  }

  return lines.join('\n')
}
