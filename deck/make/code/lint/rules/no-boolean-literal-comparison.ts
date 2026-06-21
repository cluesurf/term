// L017: comparing a value to a boolean literal (`x == wave true`, `flag != wave false`) is redundant -- the value is
// already a boolean. Use `x` (or its negation) directly. A common verbosity, and `== true` quietly differs from a
// truthiness check on non-boolean values, so flagging it nudges toward the clearer form.

import type { BinaryOp } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

const EQUALITY = new Set<BinaryOp>(['==', '!='])

export const noBooleanLiteralComparison: Rule = {
  name: 'no-boolean-literal-comparison',
  code: 'L017',
  severity: 'warning',
  docs: 'comparing to a boolean literal is redundant; use the boolean directly',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'expression') return
    const node = target.node
    if (node.form !== 'binary' || !EQUALITY.has(node.op)) return

    const { left, right, op } = node
    if (left.form !== 'boolean' && right.form !== 'boolean') return

    // the cases that reduce to the bare operand are slice-fixable: `x == true` and `x != false` are just `x`. The
    // negating cases (`x == false`, `x != true`) need a `fork lack` wrapper, so they are reported without a fix.
    const positive = (b: boolean): boolean =>
      (op === '==' && b === true) || (op === '!=' && b === false)

    let fix
    if (right.form === 'boolean' && positive(right.value)) {
      fix = { span: node.span, text: context.slice(left.span) }
    } else if (left.form === 'boolean' && positive(left.value)) {
      fix = { span: node.span, text: context.slice(right.span) }
    }

    context.report({
      message: `comparing to a boolean literal is redundant; use the boolean directly`,
      span: node.span,
      fix,
    })
  },
}
