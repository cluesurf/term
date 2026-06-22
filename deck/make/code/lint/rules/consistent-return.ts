// L027: a function that returns a value on some paths (`send back x`) but nothing on others (`send back`) is usually a
// bug -- a path that forgot its value. Either every `send back` carries a value or none does.

import type { Statement } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

// collect the function's own returns, split by whether they carry a value. Nested functions / closures are skipped:
// they have their own return contract.
function collectReturns(
  body: Statement[],
  withValue: Statement[],
  withoutValue: Statement[],
): void {
  for (const s of body) {
    switch (s.form) {
      case 'return':
        ;(s.value ? withValue : withoutValue).push(s)
        break
      case 'if':
        for (const b of s.branches) {
          collectReturns(b.body, withValue, withoutValue)
        }

        if (s.otherwise) {
          collectReturns(s.otherwise, withValue, withoutValue)
        }

        break
      case 'while':
      case 'for-each':
        collectReturns(s.body, withValue, withoutValue)
        break
      case 'match':
        for (const c of s.cases) {
          collectReturns(c.body, withValue, withoutValue)
        }

        if (s.otherwise) {
          collectReturns(s.otherwise, withValue, withoutValue)
        }

        break
      default:
        break
    }
  }
}

export const consistentReturn: Rule = {
  name: 'consistent-return',
  code: 'L027',
  severity: 'warning',
  docs: 'a function should return a value on every path or on none',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    if (node.form !== 'function') {return}

    const withValue: Statement[] = []
    const withoutValue: Statement[] = []
    collectReturns(node.body, withValue, withoutValue)

    if (withValue.length > 0 && withoutValue.length > 0) {
      context.report({
        message: `this function returns a value on some paths and nothing on others`,
        span: withoutValue[0]!.span,
      })
    }
  },
}
