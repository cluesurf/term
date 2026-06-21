// L010: an assignment whose target and value are the same place (`save x, read x`, `save p/x, read p/x`). It has no
// effect and is almost always a mistake (a wrong operand, or a change that was forgotten). Restricted to the plain `=`
// form and stable places, so a compound `x += x` (which doubles x) and an effectful target are never misreported.

import type { Rule } from '@cluesurf/make/code/lint/rule'
import {
  expressionsEqual,
  isStable,
} from '@cluesurf/make/code/compile/expr-equal'

export const noSelfAssignment: Rule = {
  name: 'no-self-assignment',
  code: 'L010',
  severity: 'warning',
  docs: 'assigning a value to itself has no effect',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') return
    const node = target.node
    if (node.form !== 'assign' || node.op !== '=') return
    if (!isStable(node.target) || !isStable(node.value)) return

    if (expressionsEqual(node.target, node.value)) {
      context.report({
        message: `this assigns a value to itself; the statement has no effect`,
        span: node.span,
      })
    }
  },
}
