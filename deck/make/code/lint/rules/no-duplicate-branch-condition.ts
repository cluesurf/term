// L009: two branches of one `fork test` chain with structurally identical conditions. The later branch can never run
// (the earlier identical condition always wins), so it is dead code, almost always a copy-paste where a different
// condition was meant. Only stable conditions are compared, so a chain of distinct effectful checks is never flagged.

import type { Rule } from '@term/make/code/lint/rule'
import {
  expressionsEqual,
  isStable,
} from '@term/make/code/compile/expr-equal'

export const noDuplicateBranchCondition: Rule = {
  name: 'no-duplicate-branch-condition',
  code: 'L009',
  severity: 'warning',
  docs: 'two branches of a fork test share a condition; the later one is unreachable',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'if') {return}

    for (let i = 1; i < node.branches.length; i++) {
      const cond = node.branches[i]!.cond

      if (!isStable(cond)) {continue}

      for (let j = 0; j < i; j++) {
        if (expressionsEqual(cond, node.branches[j]!.cond)) {
          context.report({
            message: `this condition repeats an earlier branch in the same fork; it can never run`,
            span: cond.span,
          })
          break
        }
      }
    }
  },
}
