// L044: in a lean file, every line is written the way `term form` writes it, by the five rules in
// note/term/format-rules.md. The check is Term, lint/layout-check.tree (self-hosting, 2026-10-06), and its header says
// what it reports and when it offers a fix. This face is the rule object the lint driver holds, and it hands in the
// file's milled program (format/meaning.ts) for the fix's meaning check.

import type { Rule } from '@term/make/code/lint/rule'
import { programOf } from '@term/make/code/format/meaning'
import { lineLayoutReports } from '@term/make/code/lint/layout-check'

export const lineLayout: Rule = {
  name: 'line-layout',
  code: 'L044',
  severity: 'warning',
  docs: 'in a lean file, a line is written the way `term form` writes it (format-rules.md, the five rules)',
  fixable: true,
  check() {},
  checkSource(tree, context) {
    if (!context.lean) {
      return
    }

    const reports = lineLayoutReports(tree, context.source, context.file, (parsed, file, lean) => {
      const program = programOf(parsed, file, lean)

      return program === undefined ? { form: 'none' } : { form: 'some', value: program }
    })

    for (const report of reports) {
      const fix = report.fix

      context.report({
        message: report.message,
        span: report.span,
        ...(fix && fix.form === 'put' ? { fix: { span: fix.span, text: fix.text } } : {}),
      })
    }
  },
}
