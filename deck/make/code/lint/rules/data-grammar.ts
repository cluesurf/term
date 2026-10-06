// L040: a data file (the host dialect: `host` / `list` / `mesh` / `tree` / `fuse` and literals) that breaks a rule
// of its grammar: a key given twice, a value beside children, an anchor declared after data, a fuse of an unknown
// anchor, a bare word where text belongs. The rules and their messages live in the data reader
// (code/compile/host-data.tree, note/term/host/01-grammar.md); this rule reports them as findings so `term lint` and
// the editor show a data file's problems the way they show a program's. A data file has no AST, so the visitor is
// silent: the analysis entry calls `lintData` on the tree instead.
//
// The reports are lint/data-check.tree (self-hosting, 2026-10-06). This face is the rule object the driver holds,
// and writes each report as a finding under the rule's name, code and severity.

import type { RootNode } from '@term/make/code/parser/narrow'
import type { Finding, Rule } from '@term/make/code/lint/rule'
import { dataReports } from '@term/make/code/lint/data-check'

export const dataGrammar: Rule = {
  name: 'data-grammar',
  code: 'L040',
  severity: 'error',
  docs: 'a data file that breaks a rule of the data grammar',
  fixable: false,
  check() {
    // a data file never reaches the AST walk; see lintData
  },
}

// the reader's and the expander's diagnostics as findings under this rule
export function lintData(tree: RootNode, file: string): Finding[] {
  return dataReports(tree as never, file).map(report => ({
    rule: dataGrammar.name,
    code: dataGrammar.code,
    message: report.message,
    span: report.span,
    severity: dataGrammar.severity,
  }))
}
