// The unified, DRY analysis entry. Parses the source exactly once (tolerantly, with error recovery) and exposes
// every downstream view over that single parse: the concrete tree (for formatting and trivia), the milled AST (for
// linting and type checking), the merged diagnostics, and lazy `format`/`lint`/`check` closures. This is what the
// language server drives: one parse, then format + lint + compile all read the same result. See plans/19-format-and-lint.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { RootNode } from '@term/make/code/parser/tree'
import { parseTolerant } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { compileProgram } from '@term/make/code/compile/compile'
import { formatTree } from '@term/make/code/format/format'
import { lint, applyFixes } from '@term/make/code/lint/lint'
import type { LintConfig } from '@term/make/code/lint/lint'
import type { Finding } from '@term/make/code/lint/rule'
import type { Program } from '@term/make/code/compile/node'

export type Analysis = {
  tree: RootNode
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

// gather inline lint suppressions from the tree's comment trivia: a `# lint off Lxxx` comment disables that rule on
// the following line. Walks the CST so the formatter and linter share the same comment source.
function suppressions(tree: RootNode): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>()

  const visit = (group: {
    comments?: {
      text: string
      span: { start: { line: number } }
    }[]
    nodes: unknown[]
  }) => {
    for (const comment of group.comments ?? []) {
      const found = /lint\s+off\s+([A-Za-z0-9]+)/.exec(comment.text)

      if (found) {
        const line = comment.span.start.line + 1

        if (!map.has(line)) {
          map.set(line, new Set())
        }

        map.get(line)!.add(found[1]!)
      }
    }

    for (const child of group.nodes) {
      if (
        child &&
        typeof child === 'object' &&
        (child as { kind?: string }).kind === 'group'
      ) {
        visit(child as never)
      }
    }
  }

  for (const group of tree.nodes) {
    visit(group)
  }

  return map
}

export function analyze(source: {
  file: string
  text: string
}): Analysis {
  const { tree, diagnostics } = parseTolerant(source)
  const built = mill(expandTemplates(tree), source.file)
  const program = built.ok ? built.program : null
  const all = [...diagnostics, ...(built.ok ? [] : built.diagnostics)]
  const suppress = suppressions(tree)

  return {
    tree,
    program,
    diagnostics: all,
    format: () => (diagnostics.length ? source.text : formatTree(tree)),
    lint: (config: LintConfig = {}) =>
      program
        ? lint(program, source.file, source.text, {
            ...config,
            suppress,
          })
        : [],
    fix: (config: LintConfig = {}) => {
      if (!program) {
        return source.text
      }

      const findings = lint(program, source.file, source.text, {
        ...config,
        suppress,
      })

      const fixed = applyFixes(source.text, findings)
      // re-parse + format the fixed text so the layout is normalized (a fix may leave odd spacing)
      const reparsed = parseTolerant({ file: source.file, text: fixed })

      return reparsed.diagnostics.length
        ? fixed
        : formatTree(reparsed.tree)
    },
    check: () => {
      if (!program) {
        return all
      }

      const result = compileProgram(program, source.file)

      return result.ok ? result.warnings : result.diagnostics
    },
  }
}
