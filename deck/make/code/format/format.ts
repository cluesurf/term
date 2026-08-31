// The formatter: re-print a `.tree` CST in canonical form. Operates on the concrete syntax tree (so comments are
// preserved) and is structure-preserving by construction: a group is laid out inline (`head a, b, c`) only when
// that rendering both fits the line width AND re-parses to the same structure; otherwise it is stacked with one
// child per indented line. This round-trip check is stronger than a blind pretty-printer for an
// indentation-significant syntax: the formatter can never change a program's meaning. Idempotent by design (it
// ignores the input layout and prints from the tree). Part of the one-parse pipeline (see plans/19-format-and-lint).
// Pure and browser-safe.

import { escapeTextChunks, parse } from '@term/make/code/parser/tree'
import type {
  GroupNode,
  Node,
  RootNode,
} from '@term/make/code/parser/tree'

const WIDTH = 84

// definition heads whose group never collapses onto one line: the head stays on its own line with its children
// indented below, the convention for top-level declarations.
//
// `view` is here for the same reason `task` and `form` are: its children are a BODY, not arguments. Collapsing is
// meaning-preserving (a comma returns to the head, so the tree is identical) but a whole component, or a whole
// document in the `view` role, rendered onto one line reads as nothing at all. Was `zone` until 2026-08-30 and
// was never in this set, so a short component collapsed then too.
// Control flow is in here for the same reason: `walk`, `fork` and their `hook` / `case` arms hold a BODY, not an
// argument list. Collapsing one is meaning-preserving now that a nested part is parenthesized, which is exactly
// why they had to be named: before that, the shape check refused the collapse on its own and a whole loop could
// never end up on one line. `walk list, read(xs), hook(next, take(site, name(item)), save(n, code 1))` is a real
// thing this produced, and it is unreadable.
const ALWAYS_STACK = new Set(['load', 'task', 'form', 'view', 'walk', 'fork', 'hook', 'case'])

// heads that DECLARE rather than call: their children name and type a thing. One of these does not collapse when a
// non-last child would have to be parenthesized, because such a child is another declaration. See needsParens.
const DECLARATION_HEADS = new Set([
  'host',
  'take',
  'save',
  'link',
  'slot',
  'free',
  'mark',
  'like',
  'head',
])

// the inline (comma-joined) rendering of a node: `head a, b, c`
//
// A child that has children of its own is written PARENTHESIZED (`loan(n)`), not space-separated. A comma pops
// exactly one level, so a space-nested part followed by a comma swallows what comes after it: `call add, loan n,
// code 1` reads `code 1` as a child of `loan`, and `add` gets one argument. `loan(n)` closes its own group, so
// the comma lands where it belongs. Without this the inline rendering fails `formatGroup`'s own shape check and
// every such line stacks, which is correct but turns short calls into four lines apiece.
function flatten(node: Node, nested = false): string {
  switch (node.kind) {
    case 'group': {
      const [head, ...kids] = node.nodes
      const h = head ? flatten(head) : ''
      const optional = node.optional ? '?' : ''

      if (!kids.length) {
        return `${h}${optional}`
      }

      const opensLevel = kids.some(k => k.kind === 'name' || k.kind === 'group')

      if (nested && opensLevel) {
        return `${h}${optional}(${kids.map((k, i) => flatten(k, i < kids.length - 1)).join(', ')})`
      }

      // only a part that a COMMA FOLLOWS can be swallowed, so the last one never needs parentheses: `take n,
      // like number` and `send back n` stay as they read. And only a NAME or a GROUP opens a level for a comma
      // to pop into; a number or text literal is a leaf, so `code 1` is already safe.
      const args = kids
        .map((k, i) => flatten(k, i < kids.length - 1))
        .join(', ')

      return `${h}${optional} ${args}`
    }

    case 'name':
      // an interpolation is re-emitted at ITS OWN brace depth, never a fixed `{{...}}`. A single brace is
      // compile-time SUBSTITUTION and a double brace is RUNTIME interpolation, so hardcoding two turned
      // `load @term/seed/code/native/{platform}/atomic` into `{{platform}}` and changed what the line means:
      // every platform-slot import in the stdlib, silently, the moment anyone ran `term form` over it.
      return node.parts
        .map(p =>
          p.kind === 'chunk'
            ? p.text
            : `${'{'.repeat(p.depth)}${p.group ? flatten(p.group) : ''}${'}'.repeat(p.depth)}`,
        )
        .join('')
    case 'text': {
      // the same re-escaping printTree does, computed across the WHOLE literal: an angle that cannot balance has
      // to come back out escaped or the formatted literal reads as a nested bracket and stops parsing, while a
      // balanced one is content and must be left exactly as it is
      const escaped = escapeTextChunks(
        node.parts.filter((p): p is typeof p & { kind: 'chunk' } => p.kind === 'chunk').map(p => p.text),
      )
      let at = 0

      return `<${node.parts
        .map(p => (p.kind === 'chunk' ? escaped[at++]! : `{{${p.group ? flatten(p.group) : ''}}}`))
        .join('')}>`
    }
    case 'integer':
    case 'decimal':
    case 'radix':
      return node.token.text
    default:
      return ''
  }
}

// a comparable structural fingerprint (ignores comments, spans, parents): used to verify a rendering round-trips
function shape(node: Node): string {
  switch (node.kind) {
    case 'root':
      return `R(${node.nodes.map(shape).join(',')})`
    case 'group':
      return `G${node.optional ? '?' : ''}(${node.nodes
        .map(shape)
        .join(',')})`
    case 'name':
      return `n:${flatten(node)}`
    case 'text':
      return `t:${flatten(node)}`
    default:
      return `l:${flatten(node)}`
  }
}

// the declaration heads that make up a task's signature (before its body). Runs of the same head group together;
// a head change inside the signature, and the signature->body boundary, each get a blank line.
const SIGNATURE_HEADS = new Set([
  'take',
  'free',
  'like',
  'mark',
  'hold',
])

// the head atom of a group (its first node), as text. Used to keep certain heads always stacked.
function headName(group: GroupNode): string {
  const head = group.nodes[0]

  return head ? flatten(head) : ''
}

function isLeaf(node: Node): boolean {
  return node.kind !== 'group' || node.nodes.length <= 1
}

// would this child have to be PARENTHESIZED to survive an inline rendering? That is the same test `flatten` makes,
// and it is the tell that the child is a DECLARATION rather than an atom: it has a head and children of its own.
//
// A group with such a child is not collapsed, however well it fits. Collapsing one is meaning-preserving and
// unreadable, which is the same reason the ALWAYS_STACK heads exist, except that this catches it by SHAPE rather
// than by naming a head. Two real examples from the stdlib:
//
//   host h, host(start, code 0), host end, code 360        was three legible lines
//   take precise, like(boolean), fall false                was four
//
// while `call add, code 1, code 2` still collapses, because `code 1`'s only child is a literal and a literal does
// not open a level for a comma to pop into.
//
// It applies to DECLARATION heads only. `call is-below, loan(n), code 2` is a call with arguments, and
// parenthesizing an argument reads fine; `host h, host(start, code 0), ...` is a declaration whose children are
// themselves declarations, and squashing those onto one line does not. Same shape, different head, different
// answer, so the head has to be part of the test.
function needsParens(node: Node): boolean {
  return (
    node.kind === 'group' &&
    node.nodes.length > 1 &&
    node.nodes
      .slice(1)
      .some(k => k.kind === 'name' || k.kind === 'group')
  )
}

// word-wrap a comment so no line exceeds WIDTH. A comment that already fits is emitted unchanged (so short directive
// comments like `# lint off L003` are never disturbed). A word longer than the available width (e.g. a bare URL) is
// left on its own line rather than broken mid-word.
function wrapComment(text: string, indent: string): string[] {
  const trimmed = text.trim()

  if (indent.length + trimmed.length <= WIDTH) {
    return [`${indent}${trimmed}`]
  }

  const body = trimmed.replace(/^#+\s?/, '')
  const prefix = '# '
  const max = WIDTH - indent.length
  const lines: string[] = []

  let line = prefix

  for (const word of body.split(/\s+/)) {
    if (line === prefix) {
      line = prefix + word
    } else if (line.length + 1 + word.length <= max) {
      line += ` ${word}`
    } else {
      lines.push(`${indent}${line}`)
      line = prefix + word
    }
  }

  if (line !== prefix) {
    lines.push(`${indent}${line}`)
  }

  return lines
}

function comments(group: GroupNode, indent: string): string[] {
  return (group.comments ?? []).flatMap(c =>
    wrapComment(c.text, indent),
  )
}

// does this group (or any descendant) carry a comment? Inlining would drop those comments, so such groups stack.
function hasComment(node: Node): boolean {
  if (node.kind !== 'group') {
    return false
  }

  return (node.comments?.length ?? 0) > 0 || node.nodes.some(hasComment)
}

function formatGroup(group: GroupNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const lines = comments(group, indent)
  const flat = flatten(group)

  // inline when it fits, carries no comments to preserve, and re-parses to the same structure (meaning preserved).
  // a definition head (`load` / `task` / `form`) always stays stacked: its head sits on its own line and its children
  // (params, body, fields) on indented lines, never collapsed onto one line, matching the convention for top-level
  // declarations.
  if (
    !ALWAYS_STACK.has(headName(group)) &&
    !group.nodes.some(hasComment) &&
    // a NON-LAST child that would need parentheses is another declaration, not an argument: see needsParens. The
    // last part is exempt for the same reason `flatten` exempts it, and it is the difference between the house
    // `take n, like number` (fine) and `take precise, like(boolean), fall false` (three lines squashed into one).
    !(
      DECLARATION_HEADS.has(headName(group)) &&
      group.nodes.slice(1, -1).some(needsParens)
    ) &&
    indent.length + flat.length <= WIDTH
  ) {
    const reparsed = parse({ file: 'format', text: flat })

    if (
      reparsed.ok &&
      reparsed.tree.nodes.length === 1 &&
      shape(reparsed.tree.nodes[0]!) === shape(group)
    ) {
      lines.push(`${indent}${flat}`)

      return lines
    }
  }

  // stacked: the head line keeps the head and any leading atoms (the name); the rest are indented children
  const [head, ...kids] = group.nodes

  // AT MOST ONE leading atom rides on the head line. A space NESTS, so `hook` with the two sibling children
  // `test` and `true` printed as `hook test true` re-reads as `hook > test > true` — a different tree, and the
  // second formatting pass then prints it as `hook` with `test true` indented, losing both children off the head
  // line. Taking one is safe (`hook hold`, `walk list`, `case node`) because there is nothing after it to nest
  // into; taking two is the bug. The rest go on their own indented lines, which is unambiguous.
  let split = 0

  if (kids.length > 0 && isLeaf(kids[0]!)) {
    split = 1
  }

  const headParts = [
    head ? flatten(head) : '',
    // `.map(flatten)` would hand the INDEX to `nested`, parenthesizing every leading atom but the first
    ...kids.slice(0, split).map(kid => flatten(kid)),
  ].filter(Boolean)

  lines.push(
    `${indent}${headParts.join(' ')}${group.optional ? '?' : ''}`,
  )

  // blank-line grouping inside a task body: signature lines (take / like / mark ...) are grouped by head, the first
  // real statement is set off from the signature, and a multi-line block is set off from a preceding simple statement.
  // A block followed by a statement (or two adjacent blocks) stays tight, so the indentation provides the separation.
  // Other constructs (fork / walk / make / form ...) keep their children tight; only function bodies breathe.
  const spaceBody = headName(group) === 'task'

  let prevHead: string | undefined
  let prevSignature = false
  let prevCompound = false

  for (const kid of kids.slice(split)) {
    const kidLines =
      kid.kind === 'group'
        ? formatGroup(kid, depth + 1)
        : [`${'  '.repeat(depth + 1)}${flatten(kid)}`]

    const head =
      kid.kind === 'group'
        ? headName(kid)
        : (flatten(kid).split(/[\s,]/)[0] ?? '')

    const signature = SIGNATURE_HEADS.has(head)
    const compound = kidLines.length > 1

    if (spaceBody && prevHead !== undefined) {
      const blank =
        prevSignature && signature
          ? head !== prevHead // group signature entries by head
          : prevSignature && !signature
            ? true // signature -> body boundary
            : compound && !prevCompound // set a block off from a preceding simple statement

      if (blank) {
        lines.push('')
      }
    }

    lines.push(...kidLines)
    prevHead = head
    prevSignature = signature
    prevCompound = compound
  }

  return lines
}

export function formatTree(tree: RootNode): string {
  // one blank line between top-level definitions; comments ride with their group
  return (
    tree.nodes
      .map(group => formatGroup(group, 0).join('\n'))
      .join('\n\n') + '\n'
  )
}

// format source text. Tolerant: if it does not parse, the original text is returned unchanged.
export function format(source: { file: string; text: string }): string {
  const result = parse(source)

  if (!result.ok) {
    return source.text
  }

  return formatTree(result.tree)
}
