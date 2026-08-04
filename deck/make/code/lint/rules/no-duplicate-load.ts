// L024: the same native module is loaded (`dock load`) more than once. The extra loads are redundant -- collapse them
// to one. The driver precomputes the set of modules that appear more than once.

import type { Rule } from '@term/make/code/lint/rule'

export const noDuplicateLoad: Rule = {
  name: 'no-duplicate-load',
  code: 'L024',
  severity: 'warning',
  docs: 'the same native module is loaded more than once',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'native') {return}

    if (context.duplicateLoads.has(node.module)) {
      context.report({
        message: `the module "${node.module}" is loaded more than once`,
        span: node.span,
      })
    }
  },
}
