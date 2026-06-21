// L018: a binding that exists only to be returned on the very next line (`save x, <e>` then `send back, read x`).
// Return the expression directly. A common leftover that adds a needless name.

import type { Statement } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

function bodiesOf(node: Statement): Statement[][] {
  switch (node.form) {
    case 'function':
    case 'while':
    case 'for-each':
      return [node.body]
    case 'if':
      return [
        ...node.branches.map(b => b.body),
        ...(node.otherwise ? [node.otherwise] : []),
      ]
    case 'match':
      return [
        ...node.cases.map(c => c.body),
        ...(node.otherwise ? [node.otherwise] : []),
      ]
    default:
      return []
  }
}

export const preferDirectReturn: Rule = {
  name: 'prefer-direct-return',
  code: 'L018',
  severity: 'warning',
  docs: 'a binding used only to be returned on the next line should be returned directly',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') return

    for (const body of bodiesOf(target.node)) {
      for (let i = 0; i + 1 < body.length; i++) {
        const decl = body[i]!
        const ret = body[i + 1]!

        if (
          decl.form === 'let' &&
          ret.form === 'return' &&
          ret.value?.form === 'variable' &&
          ret.value.name === decl.name
        ) {
          context.report({
            message: `"${decl.name}" is bound only to be returned next; return the value directly`,
            span: decl.span,
          })
        }
      }
    }
  },
}
