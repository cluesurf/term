// The unified, DRY analysis entry. Parses the source exactly once (tolerantly, with error recovery) and exposes
// every downstream view over that single parse: the concrete tree (for formatting and trivia), the milled AST (for
// linting and type checking), the merged diagnostics, and lazy `format`/`lint`/`check` closures. This is what the
// language server drives: one parse, then format + lint + compile all read the same result. See plans/19-format-and-lint.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { RootNode } from '@term/make/code/parser/tree'
import { parseTolerant } from '@term/make/code/parser/tree'
import { expandTemplates } from '@term/make/code/compile/template'
import { mill } from '@term/make/code/compile/mill'
import { checkView, lowerView } from '@term/make/code/compile/view'
import type { ViewCatalog } from '@term/make/code/compile/view-catalog'
import { compileProgram } from '@term/make/code/compile/compile'
import { formatTree } from '@term/make/code/format/format'
import { lint, applyFixes } from '@term/make/code/lint/lint'
import type { LintConfig } from '@term/make/code/lint/lint'
import type { Finding } from '@term/make/code/lint/rule'
import type { Program } from '@term/make/code/compile/node'
import {
  expandData,
  formatData,
  isDataTree,
  readData,
} from '@term/make/code/compile/host'
import { lintData } from '@term/make/code/lint/rules/data-grammar'

export type Analysis = {
  tree: RootNode
  // what the file is: a program, a data file (the host dialect), or a view-role document. The last two carry no
  // lint findings of the code role's kind, and a document's canonical layout is the ordinary tree formatter's.
  kind: 'code' | 'data' | 'view'
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

export function analyze(
  source: {
    file: string
    text: string
  },
  options?: {
    // the role a project's `role.tree` gives this file. A `view` document is read by its own reader, not by the
    // code mill, so without this the editor underlines every `view` line as an undefined name.
    role?: string | null
    catalog?: ViewCatalog
  },
): Analysis {
  const { tree, diagnostics } = parseTolerant(source)

  // the `view` role: the sandboxed document dialect. Same gate the compiler and `term view` call, so the editor
  // cannot be more permissive than a save. Its canonical layout is the ordinary tree formatter's, because a
  // document IS tree syntax. See note/term/view/.
  if (options?.role === 'view') {
    const read = checkView(source, { catalog: options.catalog })
    const program = read.ok ? lowerView(read.file) : null

    return {
      tree,
      kind: 'view',
      program,
      diagnostics: [...diagnostics, ...(read.ok ? [] : read.diagnostics)],
      format: () => (diagnostics.length ? source.text : formatTree(tree)),
      lint: () => [],
      fix: () => source.text,
      // the gate already ran, so there is nothing left to check separately. A document has no type checker of its
      // own: what it may say is decided by the grammar, the catalog and the caps, all of them inside `checkView`.
      check: () => (read.ok ? [] : read.diagnostics),
    }
  }

  // a data file (the host dialect, see code/compile/host.ts) has no program: it is read by the data reader, its
  // canonical layout is the data writer's, and its lint findings are the grammar's rules
  if (diagnostics.length === 0 && isDataTree(tree)) {
    return analyzeData(source, tree)
  }

  const built = mill(expandTemplates(tree), source.file)
  const program = built.ok ? built.program : null
  const all = [...diagnostics, ...(built.ok ? [] : built.diagnostics)]
  const suppress = suppressions(tree)

  return {
    tree,
    kind: 'code',
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

function analyzeData(
  source: { file: string; text: string },
  tree: RootNode,
): Analysis {
  const read = readData(tree, source.file)
  const expanded = read.ok ? expandData(read.data, source.file) : undefined
  const diagnostics = read.ok
    ? expanded && !expanded.ok
      ? expanded.diagnostics
      : []
    : read.diagnostics
  const findings = () => lintData(tree, source.file)

  return {
    tree,
    kind: 'data',
    program: null,
    diagnostics,
    // a file the reader refuses is left as written: a layout pass must never rewrite what it cannot read
    format: () =>
      diagnostics.length ? source.text : formatData(tree, source.file),
    lint: findings,
    fix: () => (diagnostics.length ? source.text : formatData(tree, source.file)),
    check: () => diagnostics,
  }
}
