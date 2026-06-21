// The formatter: re-print a `.tree` CST in canonical form. Operates on the concrete syntax tree (so comments are
// preserved) and is structure-preserving by construction: a group is laid out inline (`head a, b, c`) only when
// that rendering both fits the line width AND re-parses to the same structure; otherwise it is stacked with one
// child per indented line. This round-trip check is stronger than a blind pretty-printer for an
// indentation-significant syntax: the formatter can never change a program's meaning. Idempotent by design (it
// ignores the input layout and prints from the tree). Part of the one-parse pipeline (see plans/19-format-and-lint).
// Pure and browser-safe.

import { parse } from '@cluesurf/make/code/parser/tree'
import type {
  GroupNode,
  Node,
  RootNode,
} from '@cluesurf/make/code/parser/tree'

const WIDTH = 80

// the inline (comma-joined) rendering of a node: `head a, b, c`
function flatten(node: Node): string {
  switch (node.kind) {
    case 'group': {
      const [head, ...kids] = node.nodes
      const h = head ? flatten(head) : ''
      const optional = node.optional ? '?' : ''

      return kids.length
        ? `${h}${optional} ${kids.map(flatten).join(', ')}`
        : `${h}${optional}`
    }

    case 'name':
      return node.parts
        .map(p =>
          p.kind === 'chunk'
            ? p.text
            : `{{${p.group ? flatten(p.group) : ''}}}`,
        )
        .join('')
    case 'text':
      return `<${node.parts
        .map(p =>
          p.kind === 'chunk'
            ? p.text
            : `{{${p.group ? flatten(p.group) : ''}}}`,
        )
        .join('')}>`
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

// the head atom of a group (its first node), as text. Used to keep certain heads always stacked.
function headName(group: GroupNode): string {
  const head = group.nodes[0]

  return head ? flatten(head) : ''
}

function isLeaf(node: Node): boolean {
  return node.kind !== 'group' || node.nodes.length <= 1
}

function comments(group: GroupNode, indent: string): string[] {
  return (group.comments ?? []).map(c => `${indent}${c.text.trim()}`)
}

// does this group (or any descendant) carry a comment? Inlining would drop those comments, so such groups stack.
function hasComment(node: Node): boolean {
  if (node.kind !== 'group') {return false}

  return (node.comments?.length ?? 0) > 0 || node.nodes.some(hasComment)
}

function formatGroup(group: GroupNode, depth: number): string[] {
  const indent = '  '.repeat(depth)
  const lines = comments(group, indent)
  const flat = flatten(group)

  // inline when it fits, carries no comments to preserve, and re-parses to the same structure (meaning preserved).
  // a `load` group always stays stacked, so its `find` children sit on their own indented lines, never inline.
  if (
    headName(group) !== 'load' &&
    !group.nodes.some(hasComment) &&
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

  let split = 0

  while (split < kids.length && isLeaf(kids[split]!)) {split++}

  const headParts = [
    head ? flatten(head) : '',
    ...kids.slice(0, split).map(flatten),
  ].filter(Boolean)

  lines.push(
    `${indent}${headParts.join(' ')}${group.optional ? '?' : ''}`,
  )

  for (const kid of kids.slice(split)) {
    if (kid.kind === 'group') {lines.push(...formatGroup(kid, depth + 1))}
    else {lines.push(`${'  '.repeat(depth + 1)}${flatten(kid)}`)}
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

  if (!result.ok) {return source.text}

  return formatTree(result.tree)
}
