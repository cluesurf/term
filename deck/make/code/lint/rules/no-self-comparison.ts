// L007: comparing an expression to itself (`is-equal(x, x)`, `x is-below x`) is always true or always false. It is
// almost always a typo for a different operand, or leftover dead code. Report only; the fix is to correct the operand,
// which the linter cannot guess.

import type { BinaryOp } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'
import {
  expressionsEqual,
  isStable,
} from '@cluesurf/make/code/compile/expr-equal'

const COMPARE = new Set<BinaryOp>(['==', '!=', '<', '<=', '>', '>='])

export const noSelfComparison: Rule = {
  name: 'no-self-comparison',
  code: 'L007',
  severity: 'warning',
  docs: 'comparing an expression to itself is always constant and usually a mistake',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (node.form !== 'binary' || !COMPARE.has(node.op)) {return}

    // only stable operands: comparing a call to itself (`now() == now()`) may legitimately differ, so do not flag it
    if (!isStable(node.left)) {return}

    if (expressionsEqual(node.left, node.right)) {
      context.report({
        message: `both sides of this \`${node.op}\` are the same expression; the result is constant`,
        span: node.span,
      })
    }
  },
}
