// The unified, DRY analysis entry. Parses the source exactly once (tolerantly, with error recovery) and exposes
// every downstream view over that single parse: the concrete tree (for formatting and trivia), the milled AST (for
// linting and type checking), the merged diagnostics, and lazy `format`/`lint`/`check` closures. This is what the
// language server drives: one parse, then format + lint + compile all read the same result. See plans/19-format-and-lint.
//
// The analysis is Term, analyzer.tree (item term-self-host-001-0045): the parse, the kind of file, the suppressions and
// the four lazy answers, each kind's closures held as one case of `analysis-held`. This face keeps the `Analysis` shape
// its callers read, a closure per answer over the held case, and converts at the boundary: a role of `null` is absent,
// the program's `maybe` is `null` when there is none, and a lint config's `lean` is handed on only when the caller
// wrote the key, and its severities as a table.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { RootNode } from '@term/make/code/parser/narrow'
import type { ViewCatalog } from '@term/make/code/compile/view-catalog'
import type { LintConfig } from '@term/make/code/lint/lint'
import type { Finding } from '@term/make/code/lint/rule'
import type { Program } from '@term/make/code/compile/node'
import * as port from '@term/make/code/analyzer'

export type Analysis = {
  tree: RootNode
  // what the file is: a program, a data file (the host dialect), or a view-role document. The last two carry no
  // lint findings of the code role's kind, and a document's canonical layout is the ordinary tree formatter's.
  kind: 'code' | 'data' | 'view' | 'mill'
  program: Program | null
  diagnostics: Diagnostic[]
  // render the canonical formatting (from the tree, so it works even with type errors)
  format(): string
  // run the lint rules over the milled AST (returns [] if the source did not mill)
  lint(config?: LintConfig): Finding[]
  // lint, apply every fix, and re-format -- the full auto-fix in one call, returning the fixed + formatted source
  fix(config?: LintConfig): string
  // run the full type checker over the milled AST (parse and mill are not repeated)
  check(): Diagnostic[]
}

// the severities cross as a table of code to severity, the shape the lint driver reads (item 0078)
function askedOf(config: LintConfig): port.LintAsked {
  return {
    severity:
      config.severity === undefined
        ? undefined
        : new Map(Object.entries(config.severity)),
    lean:
      'lean' in config
        ? { form: 'some', value: config.lean }
        : { form: 'none' },
  }
}

export function analyze(
  source: {
    file: string
    text: string
  },
  options?: {
    // the role a project's `role.tree` gives this file. A `view` document is read by its own reader, not by the
    // code mill, so without this the editor underlines every `view` line as an undefined name.
    role?: string | null
    // `mark lean` on the file's role rule (projectLeanOf in call/code/role-of.ts). Without it a lean file mills as
    // longhand, so every bare head reads as an unknown name and the lint rules run over a program that is not the
    // one the build compiles.
    lean?: boolean
    catalog?: ViewCatalog
  },
): Analysis {
  const made = port.analyze(
    source,
    options?.role ?? undefined,
    options?.lean ?? false,
    options?.catalog,
  )

  const held = made.held

  return {
    tree: made.tree as unknown as RootNode,
    kind: made.kind,
    program:
      made.program.form === 'some'
        ? (made.program.value as Program)
        : null,
    diagnostics: made.diagnostics,
    format: () => port.applyFormat(held),
    lint: (config: LintConfig = {}) =>
      port.applyLint(held, askedOf(config)) as Finding[],
    fix: (config: LintConfig = {}) =>
      port.applyFix(held, askedOf(config)),
    check: () => port.applyCheck(held),
  }
}
