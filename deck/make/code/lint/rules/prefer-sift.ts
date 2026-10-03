// L042: in a lean file, `fork case, <value>` is written `sift <value>`. The two mill to the same `fork-case` form
// and emit the same code on every backend (test/compile/lean-second.ts), so the fix only respells the head.
//
// Lean files only: `fork case` stays the longhand, and a longhand file is left as it is.

import type { Rule } from '@term/make/code/lint/rule'
import type { GroupNode, Node } from '@term/make/code/parser/tree'

// the name token of a node that is a single plain word, or undefined
function wordToken(node: Node | undefined) {
  if (node?.kind === 'name' && node.parts.length === 1 && node.parts[0]!.kind === 'chunk') {
    return node.parts[0]!.token
  }

  return undefined
}

function each(nodes: Node[], visit: (group: GroupNode) => void): void {
  for (const node of nodes) {
    if (node.kind === 'group') {
      visit(node)
      each(node.nodes, visit)
    }
  }
}

export const preferSift: Rule = {
  name: 'prefer-sift',
  code: 'L042',
  severity: 'warning',
  docs: 'in a lean file, `fork case, x` is written `sift x`',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    if (!context.lean) {
      return
    }

    const lines = context.source.split('\n')

    each(tree.nodes, group => {
      const fork = wordToken(group.nodes[0])
      const marker = group.nodes[1]

      if (fork?.text !== 'fork' || marker?.kind !== 'group' || marker.nodes.length !== 1) {
        return
      }

      const caseToken = wordToken(marker.nodes[0])

      if (caseToken?.text !== 'case' || caseToken.span.start.line !== fork.span.start.line) {
        return
      }

      const line = lines[fork.span.start.line] ?? ''
      const after = /^,\s*/.exec(line.slice(caseToken.span.end.column))
      const end = caseToken.span.end.column + (after ? after[0].length : 0)

      context.report({
        message: 'in a lean file `fork case` is written `sift`',
        span: { start: fork.span.start, end: { line: fork.span.start.line, column: end } },
        fix: {
          span: { start: fork.span.start, end: { line: fork.span.start.line, column: end } },
          text: after ? 'sift ' : 'sift',
        },
      })
    })
  },
}
