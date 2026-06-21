// L005: a control-flow block with no body (an empty `fork` branch, `walk` loop, or `task`) is almost always a
// mistake or dead scaffolding. Report only: the right fix (fill it in or delete it) is the author's call.

import type { Statement } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

function emptyBlocks(s: Statement): boolean {
  switch (s.form) {
    case 'if':
      return (
        s.branches.some(b => b.body.length === 0) ||
        s.otherwise?.length === 0
      )
    case 'while':
    case 'for-each':
    case 'function':
      return s.body.length === 0
    case 'match':
      return (
        s.cases.some(c => c.body.length === 0) ||
        s.otherwise?.length === 0
      )
    default:
      return false
  }
}

export const noEmptyBlock: Rule = {
  name: 'no-empty-block',
  code: 'L005',
  severity: 'warning',
  docs: 'a branch, loop, or task with no body is probably unfinished',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') return
    if (emptyBlocks(target.node)) {
      context.report({
        message: 'this block has no body',
        span: target.node.span,
      })
    }
  },
}
