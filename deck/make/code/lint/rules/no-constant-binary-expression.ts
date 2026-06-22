// L014: a comparison whose BOTH operands are literals (`5 < 3`, `text <a> == text <b>`) has a result fixed at compile
// time, so the comparison is pointless -- usually a leftover debug value or a typo for a variable operand.

import type {
  BinaryOp,
  Expression,
} from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

const COMPARE = new Set<BinaryOp>(['==', '!=', '<', '<=', '>', '>='])

function isLiteral(node: Expression): boolean {
  return (
    node.form === 'integer' ||
    node.form === 'float' ||
    node.form === 'boolean' ||
    node.form === 'string' ||
    node.form === 'null'
  )
}

export const noConstantBinaryExpression: Rule = {
  name: 'no-constant-binary-expression',
  code: 'L014',
  severity: 'warning',
  docs: 'a comparison of two literals is always true or always false',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (node.form !== 'binary' || !COMPARE.has(node.op)) {return}

    if (isLiteral(node.left) && isLiteral(node.right)) {
      context.report({
        message: `both operands of this \`${node.op}\` are constant; the result never changes`,
        span: node.span,
      })
    }
  },
}
