// L032: a value-position conditional (`save x / fork test / hook test <c> / hook hold, wave true / hook miss, wave
// false`) whose two arms are the opposite boolean literals is just the condition itself. Use the condition directly.
// The expression-level analog of no-redundant-boolean. Fixable only on the non-negating shape (`true` arm / `false`
// otherwise), where the result is the bare condition; the reverse needs a negation, so it is reported without a fix.

import type { Rule } from '@term/make/code/lint/rule'

export const noRedundantConditional: Rule = {
  name: 'no-redundant-conditional',
  code: 'L032',
  severity: 'warning',
  docs: 'a conditional yielding a boolean literal in each arm is just the condition itself',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'expression') {return}

    const node = target.node

    // exactly one branch (a single if, not a chain) with an otherwise
    if (
      node.form !== 'conditional' ||
      node.branches.length !== 1 ||
      !node.otherwise
    ) {
      return
    }

    const branch = node.branches[0]!
    const arm = branch.value
    const other = node.otherwise

    // both arms must be opposite boolean literals
    if (
      arm.form !== 'boolean' ||
      other.form !== 'boolean' ||
      arm.value === other.value
    ) {
      return
    }

    // `true` arm / `false` otherwise collapses to the bare condition; the reverse needs a negation, so report only
    const fix =
      arm.value === true
        ? { span: node.span, text: context.slice(branch.cond.span) }
        : undefined

    context.report({
      message: `each arm of this conditional is a boolean literal; use the condition directly`,
      span: node.span,
      fix,
    })
  },
}
