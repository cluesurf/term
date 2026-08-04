// L022: a `turn next` (continue) as the last statement of a loop body does nothing -- the loop would advance anyway.
// Remove it.

import type { Statement } from '@term/make/code/compile/node'
import type { Rule } from '@term/make/code/lint/rule'

export const noRedundantContinue: Rule = {
  name: 'no-redundant-continue',
  code: 'L022',
  severity: 'warning',
  docs: 'a continue as the last statement of a loop is redundant',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'while' && node.form !== 'for-each') {return}

    const last: Statement | undefined = node.body[node.body.length - 1]

    if (last?.form === 'continue') {
      context.report({
        message: `this \`turn next\` is the last statement in the loop, so it does nothing`,
        span: last.span,
        // delete the whole line the no-op occupies (from its line start to the start of the next line)
        fix: {
          span: {
            start: { line: last.span.start.line, column: 0 },
            end: { line: last.span.end.line + 1, column: 0 },
          },
          text: '',
        },
      })
    }
  },
}
