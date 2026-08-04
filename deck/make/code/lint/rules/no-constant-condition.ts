// L006: a `fork test` whose condition is a boolean literal is dead control flow -- the branch is always (or never)
// taken. `fork test / hook test, wave true` should be the body itself; `wave false` should be dropped. Report only,
// since the right fix (collapse the fork, or correct the condition) is the author's call.

import type { Rule } from '@term/make/code/lint/rule'

export const noConstantCondition: Rule = {
  name: 'no-constant-condition',
  code: 'L006',
  severity: 'warning',
  docs: 'a fork test condition that is a constant boolean is always (or never) taken',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'if') {return}

    for (const branch of node.branches) {
      if (branch.cond.form === 'boolean') {
        context.report({
          message: `this condition is always ${branch.cond.value}; the fork is constant`,
          span: branch.cond.span,
        })
      }
    }
  },
}
