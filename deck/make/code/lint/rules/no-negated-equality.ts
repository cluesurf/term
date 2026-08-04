// L033: a negation wrapped around an equality (`fork lack` of `is-equal(a, b)`, i.e. `!(a == b)`) is clearer written
// as the opposite comparison. `!(a == b)` is `is-not-equal(a, b)`; `!(a != b)` is `is-equal(a, b)`. Report only: the
// equality is spelled as a nested call in the source (no inline operator token to flip), and the inline call form the
// rewrite would need does not round-trip reliably, so a fix could corrupt the operands. The author makes the swap.

import type { Rule } from '@term/make/code/lint/rule'

export const noNegatedEquality: Rule = {
  name: 'no-negated-equality',
  code: 'L033',
  severity: 'warning',
  docs: 'negating an equality is clearer as the opposite comparison',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (node.form !== 'unary' || node.op !== '!') {return}

    const inner = node.operand

    if (
      inner.form !== 'binary' ||
      (inner.op !== '==' && inner.op !== '!=')
    ) {
      return
    }

    const flipped = inner.op === '==' ? 'is-not-equal' : 'is-equal'

    context.report({
      message: `negating an equality is clearer as \`${flipped}\``,
      span: node.span,
    })
  },
}
