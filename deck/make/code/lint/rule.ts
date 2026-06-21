// The lint rule interface, modeled on ESLint's rule registry fused with Roslyn's analyzer/code-fix split: a rule is
// a pure visitor that `report`s findings, and a fix is a separate `TextEdit` the language server can apply. Rules run
// over the type-checked AST (not the CST), so they can see inferred types and resolved bindings. The driver walks the
// program once and dispatches every enabled rule per node, so N rules cost one traversal. See plans/19-format-and-lint.

import type {
  Severity,
  Span,
} from '@cluesurf/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'

// a source replacement: the editor swaps the text in `span` for `text`. The unit of every autofix and of the
// formatter's output, so the language server applies both the same way.
export type TextEdit = { span: Span; text: string }

// a lint finding. Shaped like a compiler Diagnostic (so the editor renders them identically) but carries a stable
// rule `code` (e.g. `L003`) for filtering and suppression, and an optional `fix`.
export type Finding = {
  rule: string
  code: string
  message: string
  span: Span
  severity: Severity
  fix?: TextEdit
}

// what a rule sees while checking a node: the file, the raw source (for span-accurate fixes), a set of names that
// are reassigned somewhere in the program (computed once by the driver), and the report sink.
export type LintContext = {
  file: string
  source: string
  reassigned: Set<string>
  slice(span: Span): string
  report(
    finding: Omit<Finding, 'rule' | 'code' | 'severity'> & {
      fix?: TextEdit
    },
  ): void
}

export type LintNode =
  | { kind: 'statement'; node: Statement }
  | { kind: 'expression'; node: Expression }

export type Rule = {
  name: string
  code: string
  severity: Severity
  docs: string
  fixable: boolean
  // called for every AST node; reports findings on the ones it cares about
  check(target: LintNode, context: LintContext): void
}
