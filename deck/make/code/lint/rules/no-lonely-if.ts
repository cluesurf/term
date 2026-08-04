// L026: a `hook miss` (else) whose only statement is another `fork test` should be an else-if (`hook test`) arm of the
// same fork instead, flattening a needless level of nesting.

import type { Rule } from '@term/make/code/lint/rule'

export const noLonelyIf: Rule = {
  name: 'no-lonely-if',
  code: 'L026',
  severity: 'warning',
  docs: 'an else that holds only an if should be an else-if arm',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'if' || !node.otherwise) {return}

    if (
      node.otherwise.length === 1 &&
      node.otherwise[0]!.form === 'if'
    ) {
      context.report({
        message: `this else holds only a fork; make it an else-if arm of the outer fork`,
        span: node.otherwise[0].span,
      })
    }
  },
}
