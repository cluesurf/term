// L004: a mutable binding (`save`) that is never reassigned should be an immutable one (`host`). The driver computes
// the set of reassigned names once and hands it in via the context. Fixable: swap the leading `save` keyword for
// `host`, verified by slicing the source so the edit is only offered when the keyword is exactly where expected.

import type { Span } from '@term/make/code/parser/diagnostic'
import type { Rule } from '@term/make/code/lint/rule'

export const preferHostForConstant: Rule = {
  name: 'prefer-host-for-constant',
  code: 'L004',
  severity: 'warning',
  docs: 'a `save` that is never reassigned should be a `host` constant',
  fixable: true,
  check(target, context) {
    if (target.kind !== 'statement') {
      return
    }

    const s = target.node

    if (s.form !== 'let' || !s.mutable) {
      return
    }

    if (context.reassigned.has(s.name)) {
      return
    }

    // an EMPTY list or hash is filled after it is bound (`save out, make list` then `push(out, x)`): never reassigned,
    // and still not a constant. A `host` binding is generalized, so the empty collection never learns its element from
    // the pushes that follow, and on Rust it comes out a boxed `Vec<Rc<dyn Any>>` where `Vec<T>` was wanted: the
    // `--fix` turned six compiling ports into `rustc` errors (self-hosting, 2026-10-04). Held by test/lint/run.ts
    const value = s.init

    // `make list` mills to an empty array literal, and `make hash` to a construction of the stdlib's `hash` form
    const empty =
      (value.form === 'array' && value.items.length === 0) ||
      (value.form === 'map' && value.entries.length === 0) ||
      (value.form === 'record' && value.name === 'hash' && value.fields.length === 0)

    if (empty) {
      return
    }

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
