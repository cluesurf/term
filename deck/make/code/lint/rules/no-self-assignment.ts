// L010: an assignment whose target and value are the same place (`save x, read x`, `save p/x, read p/x`). It has no
// effect and is almost always a mistake (a wrong operand, or a change that was forgotten). Restricted to the plain `=`
// form and stable places, so a compound `x += x` (which doubles x) and an effectful target are never misreported.

import type { Rule } from '@term/make/code/lint/rule'
import {
  expressionsEqual,
  isStable,
} from '@term/make/code/compile/expr-equal'

export const noSelfAssignment: Rule = {
  name: 'no-self-assignment',
  code: 'L010',
  severity: 'warning',
  docs: 'assigning a value to itself has no effect',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'assign' || node.op !== '=') {return}

    if (!isStable(node.target) || !isStable(node.value)) {return}

    if (expressionsEqual(node.target, node.value)) {
      context.report({
        message: `this assigns a value to itself; the statement has no effect`,
        span: node.span,
        // delete the whole line the no-op occupies
        fix: {
          span: {
            start: { line: node.span.start.line, column: 0 },
            end: { line: node.span.end.line + 1, column: 0 },
          },
          text: '',
        },
      })
    }
  },
}
