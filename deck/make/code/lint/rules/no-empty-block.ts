// L005: a control-flow block with no body (an empty `fork` branch or `walk` loop) is almost always a mistake or dead
// scaffolding. Report only: the right fix (fill it in or delete it) is the author's call.
//
// A TASK with no body is NOT one of them. A signature-only task is a deliberate, documented construct: it emits a
// stub on each native backend (`TODO` / `fatalError` / `unimplemented!`) so a declaration-only module still builds,
// which is how a binding library is written. Flagging it produced 4,757 findings across the stdlib, @term/site,
// @term/face and @term/host, essentially all of them on @term/bind-style declarations, and drowned the branch and
// loop cases that are real. The rule had no test, which is how it stayed that way.

import type { Statement } from '@term/make/code/compile/node'
import type { Rule } from '@term/make/code/lint/rule'

function emptyBlocks(s: Statement): boolean {
  switch (s.form) {
    case 'if':
      return (
        s.branches.some(b => b.body.length === 0) ||
        s.otherwise?.length === 0
      )
    case 'while':
    case 'for-each':
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
  docs: 'a branch or loop with no body is probably unfinished',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {
      return
    }

    if (emptyBlocks(target.node)) {
      context.report({
        message: 'this block has no body',
        span: target.node.span,
      })
    }
  },
}
