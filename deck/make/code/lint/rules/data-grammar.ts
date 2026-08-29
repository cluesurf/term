// L031: a data file (the host dialect: `host` / `list` / `mesh` / `tree` / `fuse` and literals) that breaks a rule
// of its grammar: a key given twice, a value beside children, an anchor declared after data, a fuse of an unknown
// anchor, a bare word where text belongs. The rules and their messages live in the data reader
// (code/compile/host.ts, note/term/host/01-grammar.md); this rule reports them as findings so `term lint` and the
// editor show a data file's problems the way they show a program's. A data file has no AST, so the visitor is
// silent: the analysis entry calls `lintData` on the tree instead.

import type { RootNode } from '@term/make/code/parser/tree'
import type { Finding, Rule } from '@term/make/code/lint/rule'
import { expandData, readData } from '@term/make/code/compile/host'

export const dataGrammar: Rule = {
  name: 'data-grammar',
  code: 'L031',
  severity: 'error',
  docs: 'a data file that breaks a rule of the data grammar',
  fixable: false,
  check() {
    // a data file never reaches the AST walk; see lintData
  },
}

// the reader's and the expander's diagnostics as findings under this rule
export function lintData(tree: RootNode, file: string): Finding[] {
  const read = readData(tree, file)
  const diagnostics = read.ok
    ? (() => {
        const expanded = expandData(read.data, file)

        return expanded.ok ? [] : expanded.diagnostics
      })()
    : read.diagnostics

  return diagnostics.map(d => ({
    rule: dataGrammar.name,
    code: dataGrammar.code,
    message: d.message,
    span: d.span,
    severity: dataGrammar.severity,
  }))
}
