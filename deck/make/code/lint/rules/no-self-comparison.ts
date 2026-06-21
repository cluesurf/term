// L007: comparing an expression to itself (`is-equal(x, x)`, `x is-below x`) is always true or always false. It is
// almost always a typo for a different operand, or leftover dead code. Report only; the fix is to correct the operand,
// which the linter cannot guess.

import type { Expression } from '@cluesurf/make/code/compile/node'
import type { BinaryOp } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

const COMPARE = new Set<BinaryOp>(['==', '!=', '<', '<=', '>', '>='])

// structural equality over the pure, side-effect-free expression shapes worth flagging: a variable, a numeric literal,
// or a member chain of either. Anything with a call (possible effects) or an unhandled shape is treated as not-equal so
// the rule never fires on something that might legitimately differ between evaluations.
function sameExpr(a: Expression, b: Expression): boolean {
  if (a.form === 'variable' && b.form === 'variable') {
    return a.name === b.name
  }
  if (a.form === 'integer' && b.form === 'integer') {
    // value is number | bigint; compare by string so 5 and 5n match without precision loss
    return String(a.value) === String(b.value)
  }
  if (a.form === 'float' && b.form === 'float') {
    return a.value === b.value
  }
  if (a.form === 'member' && b.form === 'member') {
    return a.name === b.name && sameExpr(a.target, b.target)
  }
  return false
}

export const noSelfComparison: Rule = {
  name: 'no-self-comparison',
  code: 'L007',
  severity: 'warning',
  docs: 'comparing an expression to itself is always constant and usually a mistake',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') return
    const node = target.node
    if (node.form !== 'binary' || !COMPARE.has(node.op)) return
    if (sameExpr(node.left, node.right)) {
      context.report({
        message: `both sides of this \`${node.op}\` are the same expression; the result is constant`,
        span: node.span,
      })
    }
  },
}
