// L034: comparing a collection's size to zero (`is-equal(size(items), 0)`, `is-above(size(items), 0)`) reads more
// clearly as an emptiness check (`is-empty` / `is-not-empty`). Report only: the right replacement name depends on the
// operator and the linter does not assume one canonical helper exists in scope, so it points at the pattern and lets
// the author choose. Conservative: fires only when exactly one operand is a `size(x)` call and the other is the
// integer literal 0.

import type {
  BinaryOp,
  Expression,
} from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

const COMPARE = new Set<BinaryOp>(['==', '!=', '<', '<=', '>', '>='])

// true when `e` is a `call size, <x>` (a single-argument call to the `size` builtin)
function isSizeCall(e: Expression): boolean {
  return (
    e.form === 'call' &&
    e.callee.form === 'variable' &&
    e.callee.name === 'size' &&
    e.args.length === 1
  )
}

// true when `e` is the integer literal 0
function isZero(e: Expression): boolean {
  return e.form === 'integer' && Number(e.value) === 0
}

export const preferIsEmpty: Rule = {
  name: 'prefer-is-empty',
  code: 'L034',
  severity: 'warning',
  docs: 'comparing a size to zero reads more clearly as an emptiness check',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    if (node.form !== 'binary' || !COMPARE.has(node.op)) {return}

    const sizeOnLeft = isSizeCall(node.left) && isZero(node.right)
    const sizeOnRight = isSizeCall(node.right) && isZero(node.left)

    if (sizeOnLeft || sizeOnRight) {
      context.report({
        message: `comparing a size to zero is clearer as an emptiness check (\`is-empty\` / \`is-not-empty\`)`,
        span: node.span,
      })
    }
  },
}
