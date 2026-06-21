// L012: a `fork test` whose then-branch (`hook hold`) and else-branch (`hook miss`) run exactly the same statements.
// The condition then changes nothing -- a copy-paste bug, or a leftover after the two branches were meant to diverge.
// Only fires on a simple two-way fork with fully, structurally identical bodies.

import type { Rule } from '@cluesurf/make/code/lint/rule'
import { statementListsEqual } from '@cluesurf/make/code/compile/expr-equal'

export const noIdenticalBranches: Rule = {
  name: 'no-identical-branches',
  code: 'L012',
  severity: 'warning',
  docs: 'both branches of a fork test run the same statements, so the condition has no effect',
  fixable: false,
  check(target, context) {
    if (target.kind !== 'statement') return
    const node = target.node
    if (node.form !== 'if') return
    // only a plain two-way fork: one `hook test`/`hook hold` plus a `hook miss`. A multi-arm chain is not "identical".
    if (node.branches.length !== 1 || !node.otherwise) return

    if (statementListsEqual(node.branches[0]!.body, node.otherwise)) {
      context.report({
        message: `both branches of this fork run the same statements; the condition has no effect`,
        span: node.span,
      })
    }
  },
}
