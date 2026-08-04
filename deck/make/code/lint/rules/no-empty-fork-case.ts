// L035: a `fork case` with no arms (`case` children) and no `otherwise` matches a value but handles nothing, so it is
// dead scaffolding or an unfinished match. Report only: filling in the arms (or removing the empty fork) is the
// author's call. This is more specific than no-empty-block, which does not cover a match with zero cases.

import type { Rule } from '@term/make/code/lint/rule'

export const noEmptyForkCase: Rule = {
  name: 'no-empty-fork-case',
  code: 'L035',
  severity: 'warning',
  docs: 'a fork case with no arms handles nothing and is probably unfinished',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (
      node.form === 'match' &&
      node.cases.length === 0 &&
      !node.otherwise
    ) {
      context.report({
        message: `this fork case has no arms; it matches a value but handles nothing`,
        span: node.span,
      })
    }
  },
}
