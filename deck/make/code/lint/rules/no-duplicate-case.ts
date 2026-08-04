// L013: two arms of a `fork case` with the same label. The earlier arm always matches first, so the later one can
// never run -- dead code, usually a typo or a copy-paste that should have named a different variant.

import type { Rule } from '@term/make/code/lint/rule'

export const noDuplicateCase: Rule = {
  name: 'no-duplicate-case',
  code: 'L013',
  severity: 'warning',
  docs: 'two arms of a fork case share a label; the later one is unreachable',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'match') {return}

    const seen = new Set<string>()

    for (const arm of node.cases) {
      if (seen.has(arm.label)) {
        context.report({
          message: `the case "${arm.label}" repeats an earlier arm; it can never run`,
          span: arm.body[0]?.span ?? node.span,
        })
      } else {
        seen.add(arm.label)
      }
    }
  },
}
