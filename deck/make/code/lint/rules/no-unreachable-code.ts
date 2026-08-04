// L011: a statement that directly follows a terminator (`send back`, `halt`, `turn next`, `throw`, exit) in the same
// block can never run. The IR pass drops it silently; this surfaces it to the author, who usually left it by mistake
// (a stray line after an early return, or a misindented statement). Only the unambiguous case is flagged -- a
// terminator and its sibling in one block -- never cross-branch flow, so there are no false positives.

import type { Statement } from '@term/make/code/compile/node'
import type { Rule } from '@term/make/code/lint/rule'

const TERMINATORS = new Set<Statement['form']>([
  'return',
  'break',
  'continue',
  'throw',
  'exit',
])

// every immediate child block of a statement (the arrays whose elements are siblings of each other)
function bodiesOf(node: Statement): Statement[][] {
  switch (node.form) {
    case 'function':
      return [node.body]
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

export const noUnreachableCode: Rule = {
  name: 'no-unreachable-code',
  code: 'L011',
  severity: 'warning',
  docs: 'a statement after a terminator (send back / halt / throw) in the same block can never run',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    for (const body of bodiesOf(target.node)) {
      for (let i = 0; i < body.length - 1; i++) {
        if (TERMINATORS.has(body[i]!.form)) {
          context.report({
            message: `this statement is unreachable: the previous statement in this block always exits`,
            span: body[i + 1]!.span,
          })
          break
        }
      }
    }
  },
}
