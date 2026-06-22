// L025: a `fork test` whose condition is a negation (`fork lack ...`) and which also has a `hook miss` (else) reads
// backward -- the reader parses the negative case first. Invert the condition and swap the branches for clarity.

import type { Rule } from '@cluesurf/make/code/lint/rule'

export const noNegatedCondition: Rule = {
  name: 'no-negated-condition',
  code: 'L025',
  severity: 'warning',
  docs: 'a negated condition with an else is clearer inverted',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (
      node.form !== 'if' ||
      node.branches.length !== 1 ||
      !node.otherwise ||
      node.otherwise.length === 0
    )
      {return}

    const cond = node.branches[0]!.cond
    const negated =
      cond.form === 'unary' && cond.op === '!'
        ? true
        : cond.form === 'binary' && cond.op === '!='

    if (negated) {
      context.report({
        message: `this fork tests a negative and has an else; invert the condition and swap the branches`,
        span: cond.span,
      })
    }
  },
}
