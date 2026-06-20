// The unified, DRY analysis entry. Parses the source exactly once (tolerantly, with error recovery) and exposes
// every downstream view over that single parse: the concrete tree (for formatting and trivia), the milled AST (for
// linting and type checking), the merged diagnostics, and lazy `format`/`lint`/`check` closures. This is what the
// language server drives: one parse, then format + lint + compile all read the same result. See plans/19-format-and-lint.

import type { Diagnostic } from '@/code/parser/diagnostic'
import type { RootNode } from '@/code/parser/tree'
import { parseTolerant } from '@/code/parser/tree'
import { expandTemplates } from '@/code/compile/template'
import { mill } from '@/code/compile/mill'
import { compileProgram } from '@/code/compile/compile'
import { formatTree } from '@/code/format/format'
import { lint } from '@/code/lint/lint'
import type { LintConfig } from '@/code/lint/lint'
import type { Finding } from '@/code/lint/rule'
import type { Program } from '@/code/compile/node'

export type Analysis = {
  tree: RootNode
  program: Program | null
  diagnostics: Array<Diagnostic>
  // render the canonical formatting (from the tree, so it works even with type errors)
  format(): string
  // run the lint rules over the milled AST (returns [] if the source did not mill)
  lint(config?: LintConfig): Array<Finding>
  // run the full type checker over the milled AST (parse and mill are not repeated)
  check(): Array<Diagnostic>
}

// gather inline lint suppressions from the tree's comment trivia: a `# lint off Lxxx` comment disables that rule on
// the following line. Walks the CST so the formatter and linter share the same comment source.
function suppressions(tree: RootNode): Map<number, Set<string>> {
  const map = new Map<number, Set<string>>()
  const visit = (group: {
    comments?: Array<{
      text: string
      span: { start: { line: number } }
    }>
    nodes: Array<unknown>
  }) => {
    for (const comment of group.comments ?? []) {
      const found = comment.text.match(/lint\s+off\s+([A-Za-z0-9]+)/)
      if (found) {
        const line = comment.span.start.line + 1
        if (!map.has(line)) map.set(line, new Set())
        map.get(line)!.add(found[1]!)
      }
    }
    for (const child of group.nodes)
      if (
        child &&
        typeof child === 'object' &&
        (child as { kind?: string }).kind === 'group'
      )
        visit(child as never)
  }
  for (const group of tree.nodes) visit(group as never)
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
    check: () => {
      if (!program) return all
      const result = compileProgram(program, source.file)
      return result.ok ? result.warnings : result.diagnostics
    },
  }
}
