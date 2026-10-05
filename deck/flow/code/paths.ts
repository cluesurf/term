// Where a document NAMES another file or a definition, read off the parse tree: the path of every `load` / `bear`
// (at any depth, so a mill's `bind mine, load ./mine` counts), a manifest's `code ./src` and `link @scope/name`,
// every `find x` under a load, and every top-level declaration with the position of its name. Cmd+click and
// document links are queries over these. One parser (note/term/one-parser.md): nothing here matches lines.
//
// This module finds paths and never RESOLVES one. Resolution is the server's `resolveModule`, which asks the
// resolver the compiler is given, so a path the editor opens is the file the build reads.

import { parseTolerant, renderHead } from '@term/make/code/parser/tree'
import type { Node } from '@term/make/code/parser/tree'
import type { GroupNode } from '@term/make/code/parser/narrow'
import { groupsOf } from '@term/make/code/parser/narrow'
import { spanOfNode } from '@term/make/code/compile/mill-run'
import type { Span } from '@term/make/code/parser/diagnostic'

export type PathMention = {
  // the path as written, `{platform}` and all
  path: string
  // the path's own span (what is underlined and clicked)
  span: Span
  // the head that names it: `load`, `bear`, or a manifest's `link` or `code`
  head: string
  // the names its `find` lines ask for, each with the span of the name
  finds: { name: string; span: Span }[]
}

export type Declaration = { name: string; head: string; span: Span }

const headWord = (group: GroupNode): string | undefined => {
  const first = group.nodes[0]

  return first?.kind === 'name' ? renderHead(first) : undefined
}

// the first name of a node: the node itself, or the head of a group
function firstName(node: Node | undefined): Node | undefined {
  if (node?.kind === 'name') {
    return node
  }

  if (node?.kind === 'group' && node.nodes[0]?.kind === 'name') {
    return node.nodes[0]
  }

  return undefined
}

// every path a document names. `inManifest` reads a `deck.tree`: there `bear` and `link` sit under the `deck` head.
export function pathMentions(file: string, text: string): PathMention[] {
  const { tree } = parseTolerant({ file, text })
  const out: PathMention[] = []

  const visit = (group: GroupNode, underDeck: boolean): void => {
    const head = headWord(group)

    // a manifest's `code ./src` names its code root, a folder (its `code <1.4.2>` is the old version spelling, a
    // text literal and no path, so `firstName` finds nothing there)
    if (head === 'load' || head === 'bear' || (underDeck && (head === 'link' || head === 'code'))) {
      const target = firstName(group.nodes[1])
      const start = target ? spanOfNode(target) : undefined
      // the WHOLE path as written: the name node's own span stops where an interpolation (`{platform}`) begins,
      // and a path is one line
      const span = start && target
        ? { start: start.start, end: { line: start.start.line, column: start.start.column + renderHead(target).length } }
        : undefined

      if (target && span) {
        const finds: PathMention['finds'] = []

        for (const child of group.nodes.slice(2)) {
          if (child.kind !== 'group' || headWord(child) !== 'find') {
            continue
          }

          const name = firstName(child.nodes[1])
          const at = name ? spanOfNode(name) : undefined

          if (name && at) {
            finds.push({ name: renderHead(name), span: at })
          }
        }

        out.push({ path: renderHead(target), span, head, finds })
      }
    }

    for (const child of group.nodes.slice(1)) {
      if (child.kind === 'group') {
        visit(child, underDeck || head === 'deck')
      }
    }
  }

  for (const group of groupsOf(tree.nodes)) {
    visit(group, false)
  }

  return out
}

// the heads whose second word a file DECLARES at its top level: the code role's definitions, a component, and a
// mill definition's rules
const DECLARING = new Set(['task', 'form', 'mask', 'bind', 'host', 'view', 'rule', 'tree', 'mine', 'mint', 'mill'])

export function declarationsOf(file: string, text: string): Declaration[] {
  const { tree } = parseTolerant({ file, text })
  const out: Declaration[] = []

  for (const group of groupsOf(tree.nodes)) {
    const head = headWord(group)

    if (!head || !DECLARING.has(head)) {
      continue
    }

    const name = firstName(group.nodes[1])
    const span = name ? spanOfNode(name) : undefined

    if (name && span) {
      out.push({ name: renderHead(name), head, span })
    }
  }

  return out
}

const contains = (span: Span, line: number, character: number): boolean =>
  (line > span.start.line || (line === span.start.line && character >= span.start.column)) &&
  (line < span.end.line || (line === span.end.line && character <= span.end.column))

export function mentionAt(
  mentions: PathMention[],
  line: number,
  character: number,
): { mention: PathMention; find?: string } | undefined {
  for (const mention of mentions) {
    if (contains(mention.span, line, character)) {
      return { mention }
    }

    const find = mention.finds.find(f => contains(f.span, line, character))

    if (find) {
      return { mention, find: find.name }
    }
  }

  return undefined
}

// the kebab-case word under a position, from the text
export function wordAt(text: string, line: number, character: number): string | undefined {
  const row = text.split('\n')[line] ?? ''

  let from = Math.min(character, row.length)
  let to = from

  while (from > 0 && /[A-Za-z0-9-]/.test(row[from - 1]!)) {
    from--
  }

  while (to < row.length && /[A-Za-z0-9-]/.test(row[to]!)) {
    to++
  }

  const word = row.slice(from, to)

  return /^[A-Za-z][A-Za-z0-9-]*$/.test(word) ? word : undefined
}
