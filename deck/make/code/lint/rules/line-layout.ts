// L044: in a lean file, every line is written the way `term form` writes it, by the five rules in
// note/term/format-rules.md, "Where each part of a line goes". The fix writes the formatter's lines.
//
//   1. a statement is one line: `push items, 2`
//   2. Term's own words chain with commas: `save items, make list, 3, 1`, `like list, like number`
//   3. a call in statement or CONDITION position reads with commas, `want hold, is-equal get(found, 1), 14`, and a
//      call in VALUE position takes parentheses, `back multiply(n, 2)`, `push result, read-number(cursor)`
//   4. a block stacks from the block on, and the parts before it stay on the head line: `map items` over its `task`
//   5. past 84 columns, or with a comment inside, the group stacks
//
// It does not restate the rules: it asks the formatter (format/format.ts `formatGroupLines`) how each group is laid
// out and reports the outermost group written otherwise, with a fix that writes the formatter's lines. A group whose
// head line already matches is not reported as a whole: the difference is further in, and the finding goes there.
// Blank lines are not this rule's business (format-rules.md, "Blank lines"), so they are ignored in the comparison,
// and the fix writes the formatter's lines as `term form` would, blank lines included.
//
// LEAN FILES ONLY. Rule 3's parentheses are what a lean file writes for a call, and in a longhand file a call is
// `call f` over its arguments, one per line, which the rules would fold onto one line nearly everywhere. Every layout
// it proposes re-parses to the same tree, and the fix is offered only when the fixed file mills to the same program
// (format/meaning.ts), so it cannot change what a program means. Was `inline-simple-value`, which did rule 1 for a
// single child and nothing else.

import type { Rule } from '@term/make/code/lint/rule'
import { parse } from '@term/make/code/parser/tree'
import type { GroupNode, Node } from '@term/make/code/parser/tree'
import type { Span } from '@term/make/code/parser/diagnostic'
import { formatGroupLines, valuePlaces } from '@term/make/code/format/format'
import { programOf } from '@term/make/code/format/meaning'

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

// which of the five rules a difference falls under, for the message
function ruleOf(written: string[], laid: string[]): string {
  if (laid.length === 1 && written.length > 1) {
    return 'a statement is one line (rules 1 and 2)'
  }

  if (laid.length > 1 && written.length === 1) {
    return 'a block, a line past 84 columns or a comment inside stacks (rules 4 and 5)'
  }

  const bare = (lines: string[]) => lines.join('\n').replace(/[(),]/g, ' ').replace(/\s+/g, ' ')

  if (written.length === laid.length && bare(written) === bare(laid)) {
    return 'a call in a value position takes parentheses, and one in a statement or condition reads with commas (rule 3)'
  }

  return 'a block stacks from the block on, and the parts before it stay on the head line (rule 4)'
}

export const lineLayout: Rule = {
  name: 'line-layout',
  code: 'L044',
  severity: 'warning',
  docs: 'in a lean file, a line is written the way `term form` writes it (format-rules.md, the five rules)',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    if (!context.lean) {
      return
    }

    const lines = context.source.split('\n')
    const dense = (list: string[]) => list.map(line => line.trimEnd()).filter(line => line.trim() !== '')

    // the file's program, read once, for the fix's own meaning check
    let before: string | undefined | null = null

    const keeps = (fixed: string): boolean => {
      if (before === null) {
        const parsed = parse({ file: context.file, text: context.source })

        before = parsed.ok ? programOf(parsed.tree, context.file, true) : undefined
      }

      const reparsed = parse({ file: context.file, text: fixed })

      return before !== undefined && reparsed.ok && programOf(reparsed.tree, context.file, true) === before
    }

    const visit = (group: GroupNode, value: boolean, parent: GroupNode | undefined): void => {
      const own = extent(group)
      const line = own.first?.line
      const column = own.first?.column

      // only a group that opens its own line can be laid out on its own
      if (line === undefined || column === undefined || own.last === undefined || (lines[line] ?? '').search(/\S/) !== column) {
        return
      }

      const written = dense(lines.slice(line, own.last.line + 1))
      const laid = formatGroupLines(group, Math.floor(column / 2), { lean: true, wrap: false }, value, parent)

      // the group's own leading comments sit above its first line, outside what was written
      while (laid.length > 0 && laid[0]!.trim().startsWith('#')) {
        laid.shift()
      }

      const target = dense(laid)

      if (target.join('\n') === written.join('\n')) {
        return
      }

      // the head line is already right: the difference is in a part below it
      if (target.length > 1 && written.length > 1 && target[0] === written[0]) {
        const places = valuePlaces(group)

        group.nodes.slice(1).forEach((kid, i) => {
          if (kid.kind === 'group') {
            visit(kid, places[i] ?? false, group)
          }
        })

        return
      }

      // a line holding a comment after its code is left as written: there is nowhere for the formatter to put it
      if (written.some(text => /\s#(\s|$)/.test(text))) {
        return
      }

      const start = { line, column: 0 }
      const end = { line: own.last.line, column: (lines[own.last.line] ?? '').length }
      const text = laid.join('\n')
      const fixed = [...lines.slice(0, line), text, ...lines.slice(own.last.line + 1)].join('\n')

      if (!keeps(fixed)) {
        return
      }

      context.report({
        message: `${ruleOf(written, target)}: \`${target[0]!.trim()}\``,
        span: { start: { line, column }, end },
        fix: { span: { start, end }, text },
      })
    }

    for (const group of tree.nodes) {
      visit(group, false, undefined)
    }
  },
}
