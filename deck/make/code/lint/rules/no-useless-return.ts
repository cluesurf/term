// L028: a value-less `send back` as the very last statement of a function does nothing -- the function returns at the
// end anyway. Remove it.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noUselessReturn: Rule = {
  name: 'no-useless-return',
  code: 'L028',
  severity: 'warning',
  docs: 'a value-less return as the last statement of a function is redundant',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'function') {return}

    const last = node.body[node.body.length - 1]

    if (last?.form === 'return' && !last.value) {
      context.report({
        message: `this \`send back\` has no value and is the last statement, so it does nothing`,
        span: last.span,
        // delete the whole line the no-op occupies
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
