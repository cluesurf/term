// L016: a double negation (`fork lack` of a `fork lack`, i.e. `!!x`) cancels out. Use the value directly. Often a
// leftover from a refactor or a misunderstanding of truthiness.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noDoubleNegation: Rule = {
  name: 'no-double-negation',
  code: 'L016',
  severity: 'warning',
  docs: 'a double negation is redundant; use the value directly',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (
      node.form === 'unary' &&
      node.op === '!' &&
      node.operand.form === 'unary' &&
      node.operand.op === '!'
    ) {
      // the fix slices the inner operand's existing source text, so it is exact regardless of how it is written
      context.report({
        message: `double negation is redundant; use the value directly`,
        span: node.span,
        fix: {
          span: node.span,
          text: context.slice(node.operand.operand.span),
        },
      })
    }
  },
}
