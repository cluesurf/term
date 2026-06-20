// L003: arithmetic with a neutral operand (`x + 0`, `0 + x`, `x - 0`, `x * 1`, `1 * x`, `x / 1`) is redundant.
// Fixable: the fix replaces the whole expression with the surviving operand, sliced verbatim from the source so the
// edit is exact. Only the identities that preserve the other operand's value AND its side effects are offered, so
// `x * 0` is deliberately excluded (it would drop x, whose evaluation may have effects). Mirrors the IR simplifier.

import type { Expression } from '@/code/compile/node'
import type { Rule } from '@/code/lint/rule'

function isLiteral(expr: Expression, value: number): boolean {
  return (
    (expr.form === 'integer' || expr.form === 'float') &&
    Number(expr.value) === value
  )
}

export const noRedundantArithmetic: Rule = {
  name: 'no-redundant-arithmetic',
  code: 'L003',
  severity: 'warning',
  docs: 'arithmetic against a neutral element (+0, -0, *1, /1) has no effect and should be removed',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'expression') return
    const e = target.node
    if (e.form !== 'binary') return

    let survivor: Expression | undefined
    if (
      (e.op === '+' && isLiteral(e.right, 0)) ||
      (e.op === '-' && isLiteral(e.right, 0))
    )
      survivor = e.left
    else if (e.op === '+' && isLiteral(e.left, 0)) survivor = e.right
    else if (
      (e.op === '*' && isLiteral(e.right, 1)) ||
      (e.op === '/' && isLiteral(e.right, 1))
    )
      survivor = e.left
    else if (e.op === '*' && isLiteral(e.left, 1)) survivor = e.right
    if (!survivor) return

    context.report({
      message: `this \`${e.op}\` has no effect; the result is just the other operand`,
      span: e.span,
      fix: { span: e.span, text: context.slice(survivor.span) },
    })
  },
}
