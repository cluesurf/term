// L023: when every branch of a `fork test` already exits (`send back` / `halt` / `throw`), the `hook miss` (else) is
// unnecessary -- its body can be unindented to follow the fork. Reduces nesting.

import type { Statement } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

const TERMINATORS = new Set<Statement['form']>([
  'return',
  'throw',
  'break',
  'continue',
  'exit',
])

function endsInExit(body: Statement[]): boolean {
  const last = body[body.length - 1]
  return !!last && TERMINATORS.has(last.form)
}

export const noElseReturn: Rule = {
  name: 'no-else-return',
  code: 'L023',
  severity: 'warning',
  docs: 'an else is unnecessary when every branch above it already exits',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') return
    const node = target.node
    if (node.form !== 'if' || !node.otherwise || node.otherwise.length === 0)
      return

    if (node.branches.length > 0 && node.branches.every(b => endsInExit(b.body))) {
      context.report({
        message: `every branch already exits, so this else is unnecessary; unindent its body`,
        span: node.span,
      })
    }
  },
}
