// L031: a `fork test` that returns `wave true` from its only branch and `wave false` from its else (or the reverse) is
// just the condition itself (or its negation). Return the boolean condition directly. The classic
// `if cond { return true } else { return false }` verbosity. Fixable only on the non-negating shape, where the result
// is the bare condition sliced verbatim; the negating shape (`true` in the else) is reported without a fix because the
// rewrite needs a `fork lack` wrapper.

import type { Statement } from '@cluesurf/make/code/compile/node'
import type { Rule } from '@cluesurf/make/code/lint/rule'

// the single statement of a one-statement block, or undefined
function onlyStatement(body: Statement[]): Statement | undefined {
  return body.length === 1 ? body[0] : undefined
}

// the boolean value a block returns, when it is exactly one `send back <boolean literal>`, else undefined
function returnedBoolean(body: Statement[]): boolean | undefined {
  const stmt = onlyStatement(body)

  if (
    stmt &&
    stmt.form === 'return' &&
    stmt.value &&
    stmt.value.form === 'boolean'
  ) {
    return stmt.value.value
  }

  return undefined
}

export const noRedundantBoolean: Rule = {
  name: 'no-redundant-boolean',
  code: 'L031',
  severity: 'warning',
  docs: 'returning a boolean literal from each branch of a fork is just the condition itself',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') {return}

    const node = target.node

    // exactly one `hook test` (a single if, not an else-if chain) with an else
    if (
      node.form !== 'if' ||
      node.branches.length !== 1 ||
      !node.otherwise
    ) {
      return
    }

    const branch = node.branches[0]!
    const thenValue = returnedBoolean(branch.body)
    const elseValue = returnedBoolean(node.otherwise)

    // both branches must return opposite boolean literals
    if (
      thenValue === undefined ||
      elseValue === undefined ||
      thenValue === elseValue
    ) {
      return
    }

    // `true` then / `false` else collapses to the bare condition; the reverse needs a negation, so report only.
    // The inline `send back, <cond>` form is only valid when the condition is a single line, so a multi-line
    // condition is reported without a fix rather than risk producing an unparsable rewrite.
    const singleLineCond =
      branch.cond.span.start.line === branch.cond.span.end.line

    const fix =
      thenValue === true && singleLineCond
        ? {
            span: node.span,
            text: `send back, ${context.slice(branch.cond.span)}`,
          }
        : undefined

    context.report({
      message: `each branch returns a boolean literal; return the condition directly`,
      span: node.span,
      fix,
    })
  },
}
