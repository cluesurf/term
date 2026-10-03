// L044: in a lean file, a single-child value goes on its parent's line. `save result` over `make list` is
// `save result, make list`, `like list` over `like number` is `like list, like number`, `view p` over `who` is
// `view p, who`, `back` over `multiply(side, side)` is `back multiply(side, side)`.
//
// The fix joins the two lines as WRITTEN, with a comma after a head line that already carries a part and a space
// after a bare head, and keeps the child's own spelling: a call written `multiply(side, side)` keeps its
// parentheses. It is offered only where the joined line fits 84 columns and parses to the same tree, so it can
// never change what the program means. `term form` makes the same move in every file (format/format.ts).
//
// Only a group with exactly ONE child stacked under it, and only one that holds a value rather than a body: a
// definition, a loop, a fork and its arms stay stacked, and so does a `view` that is not a simple placement.

import type { Rule } from '@term/make/code/lint/rule'
import { parse, printTree } from '@term/make/code/parser/tree'
import type { GroupNode, Node } from '@term/make/code/parser/tree'
import type { Span } from '@term/make/code/parser/diagnostic'

const WIDTH = 84

// the heads whose children are a body, never a value: format/format.ts ALWAYS_STACK
const BODY_HEADS = new Set(['load', 'task', 'form', 'view', 'walk', 'fork', 'sift', 'hook', 'case', 'deck', 'tree', 'fuse', 'mask', 'rule', 'test', 'hold', 'miss', 'note'])

// the first and last source position a node's own tokens cover
function extent(node: Node): { first?: Span['start']; last?: Span['end'] } {
  let first: Span['start'] | undefined
  let last: Span['end'] | undefined

  const take = (span: Span) => {
    if (!first || span.start.line < first.line || (span.start.line === first.line && span.start.column < first.column)) {
      first = span.start
    }

    if (!last || span.end.line > last.line || (span.end.line === last.line && span.end.column > last.column)) {
      last = span.end
    }
  }

  const visit = (n: Node): void => {
    switch (n.kind) {
      case 'group':
        n.nodes.forEach(visit)
        break
      case 'name':
      case 'text':
        for (const part of n.parts) {
          if (part.kind === 'chunk') {
            take(part.token.span)
          } else if (part.group) {
            visit(part.group)
          }
        }

        break
      case 'integer':
      case 'decimal':
      case 'radix':
        take(n.token.span)
        break
      default:
        break
    }
  }

  visit(node)

  return { first, last }
}

function headWord(group: GroupNode): string {
  const head = group.nodes[0]

  return head?.kind === 'name' ? head.parts.map(p => (p.kind === 'chunk' ? p.text : '')).join('') : ''
}

// a `view` placement whose one child is a text or a bare word (`view p, who`), as against a definition or a
// placement with markup under it
function simplePlacement(group: GroupNode, depth: number): boolean {
  const [, tag, value] = group.nodes
  const word = (node: Node | undefined) =>
    node?.kind === 'group' && node.nodes.length === 1 && node.nodes[0]!.kind === 'name'

  return depth > 0 && group.nodes.length === 3 && word(tag) && (value?.kind === 'text' || word(value))
}

// the words that head a VALUE rather than a call: a construction, a type, a read, a literal's head, an awaited call
const VALUE_HEADS = new Set(['make', 'like', 'read', 'text', 'code', 'wait'])

// What may join its parent's line. A word or a literal; a call written with its parentheses, `multiply(side,
// side)`; or a value headed by one of VALUE_HEADS, `make list`, `like number`. NOT a call written with a space,
// `greet <ada>`: joined, it would be a call that is not the head of its line and still has no parentheses, which
// the lean house style refuses. And not a `bind` line, which is a named argument and reads as one on its own line.
function simpleValue(kid: Node, written: string): boolean {
  if (kid.kind !== 'group') {
    return true
  }

  if (kid.nodes.length === 1) {
    return true
  }

  const word = headWord(kid)

  return VALUE_HEADS.has(word) || written.startsWith(`${word}(`)
}

export const inlineSimpleValue: Rule = {
  name: 'inline-simple-value',
  code: 'L044',
  severity: 'warning',
  docs: 'in a lean file, a single-child value goes on its parent\'s line',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    if (!context.lean) {
      return
    }

    const lines = context.source.split('\n')

    const visit = (group: GroupNode, depth: number): void => {
      const own = extent(group)
      const head = group.nodes[0] ? extent(group.nodes[0]) : {}
      const line = head.first?.line
      const word = headWord(group)

      if (
        line !== undefined &&
        head.first !== undefined &&
        own.last !== undefined &&
        own.last.line === line + 1 &&
        (lines[line] ?? '').search(/\S/) === head.first.column &&
        (!BODY_HEADS.has(word) || (word === 'view' && simplePlacement(group, depth)))
      ) {
        const stacked = group.nodes.slice(1).filter(kid => (extent(kid).first?.line ?? line) > line)
        const onHead = group.nodes.length - 1 - stacked.length
        const headText = (lines[line] ?? '').trim()
        const kidText = (lines[line + 1] ?? '').trim()
        const joined = `${headText}${onHead > 0 ? ', ' : ' '}${kidText}`
        const reparsed = parse({ file: context.file, text: joined })

        if (
          stacked.length === 1 &&
          simpleValue(stacked[0]!, kidText) &&
          !/\s#(\s|$)|^#/.test(headText) &&
          !/\s#(\s|$)|^#/.test(kidText) &&
          head.first.column + joined.length <= WIDTH &&
          reparsed.ok &&
          reparsed.tree.nodes.length === 1 &&
          printTree(reparsed.tree) === printTree({ kind: 'root', nodes: [group] })
        ) {
          const end = { line: line + 1, column: (lines[line + 1] ?? '').trimEnd().length }

          context.report({
            message: `a single-child value goes on its parent's line: \`${joined}\``,
            span: { start: head.first, end },
            fix: { span: { start: head.first, end }, text: joined },
          })

          return
        }
      }

      for (const kid of group.nodes) {
        if (kid.kind === 'group') {
          visit(kid, depth + 1)
        }
      }
    }

    for (const group of tree.nodes) {
      visit(group, 0)
    }
  },
}
