// L004: a mutable binding (`save`) that is never reassigned should be an immutable one (`host`). The driver computes
// the set of reassigned names once and hands it in via the context. Fixable: swap the leading `save` keyword for
// `host`, verified by slicing the source so the edit is only offered when the keyword is exactly where expected.

import type { Span } from '@/code/parser/diagnostic'
import type { Rule } from '@/code/lint/rule'

export const preferHostForConstant: Rule = {
  name: 'prefer-host-for-constant',
  code: 'L004',
  severity: 'warning',
  docs: 'a `save` that is never reassigned should be a `host` constant',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') return
    const s = target.node
    if (s.form !== 'let' || !s.mutable) return
    if (context.reassigned.has(s.name)) return

    const keyword: Span = {
      start: s.span.start,
      end: { line: s.span.start.line, column: s.span.start.column + 4 },
    }
    const fixable = context.slice(keyword) === 'save'
    context.report({
      message: `"${s.name}" is never reassigned; use \`host\` instead of \`save\``,
      span: s.span,
      fix: fixable ? { span: keyword, text: 'host' } : undefined,
    })
  },
}
