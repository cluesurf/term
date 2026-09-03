// The lint rule interface, modeled on ESLint's rule registry fused with Roslyn's analyzer/code-fix split: a rule is
// a pure visitor that `report`s findings, and a fix is a separate `TextEdit` the language server can apply. Rules run
// over the type-checked AST (not the CST), so they can see inferred types and resolved bindings. The driver walks the
// program once and dispatches every enabled rule per node, so N rules cost one traversal. See plans/19-format-and-lint.

import type {
  Severity,
  Span,
} from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@term/make/code/compile/node'

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

// Whole-program facts a rule needs that cost a full sweep to compute.
//
// Created once per `lint()` call and shared BY REFERENCE into every rule's context, so a rule fills a field on first
// use and every later node of that program reads it back. One traversal already serves N rules; this makes one
// analysis serve them too.
//
// It replaces two module-level `WeakMap<Program, ...>` caches, which Term cannot express (self-hosting-0002). A
// file-keyed cache was tried first and is WRONG for a reason worth recording: a file name does not identify a
// program. The lint suite compiles dozens of different sources as `t.tree`, so the second one read the first one's
// answer and three rules reported nothing. Tied to the call rather than to a key, there is nothing to collide.
export type LintMemo = {
  // exception name -> the raises reachable from it (unhandled-raise, L041)
  raises?: Map<string, Set<string>>
  // the tell-advice rules' view of the program (L037 to L039). Shaped by that rule file, opaque here.
  tell?: unknown
}

// what a rule sees while checking a node: the file, the raw source (for span-accurate fixes), a set of names that
// are reassigned somewhere in the program, a set of every name read somewhere in the program (both computed once by
// the driver), and the report sink.
export type LintContext = {
  file: string
  source: string
  reassigned: Set<string>
  // every variable name read anywhere in the program, including inside closure bodies; used to detect names that are
  // declared (e.g. a native import alias) but never used
  referenced: Set<string>
  // native-import modules that are loaded more than once in the program (used by no-duplicate-load)
  duplicateLoads: Set<string>
  // the whole program the node belongs to, for a rule whose answer needs more than the node (the tell advice rules
  // read every exception form and the raise sets)
  program: Program
  // whole-program analyses, computed at most once per lint call. See LintMemo above.
  memo: LintMemo
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
