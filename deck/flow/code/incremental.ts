// The incremental analyzer: the editor/dev front-end on the query-engine compiler (`QueryCompiler`). Where `analyze`
// recompiles the whole program on every edit, this re-checks only the definitions that actually changed (the signature
// firewall), so a keystroke re-types one function, not the project. It produces the same LSP diagnostics plus a typed
// program (assembled from the per-definition typed clones) for navigation / hover.
// See note/seed/plan/functional-checker.md and compilation-performance.md (Tier 2).

import { QueryCompiler } from '@cluesurf/make/code/compile/incremental'
import { LOW, HIGH } from '@cluesurf/make/code/compile/query'
import { collectModules } from '@cluesurf/make/code/compile/load'
import type { Resolver, Source } from '@cluesurf/make/code/compile/load'
import type { Program } from '@cluesurf/make/code/compile/node'
import { toLspDiagnostic } from '@cluesurf/flow/code/analyze'
import type { LspDiagnostic } from '@cluesurf/flow/code/analyze'

export class IncrementalAnalyzer {
  // public for stats / tests (the query database tracks per-key recompute counts)
  readonly compiler = new QueryCompiler()
  private files: Array<string> = []

  constructor(private readonly resolve?: Resolver) {}

  // analyze a document: collect its module graph, set sources, return incremental diagnostics + the typed program.
  // Async: the per-definition chains (resolve -> type-check) run concurrently under one query transaction.
  async analyze(document: Source): Promise<{
    diagnostics: Array<LspDiagnostic>
    program?: Program
  }> {
    const sources = this.resolve
      ? collectModules(document, this.resolve).sources
      : [document]
    this.files = sources.map(s => s.file)
    // the edited document is LOW durability (it changes constantly); its dependencies (stdlib, framework, other
    // modules) are HIGH (rarely change in a session). So editing the document validates dep-derived queries in O(1).
    for (const source of sources)
      this.compiler.setSource(
        source.file,
        source.text,
        source.file === document.file ? LOW : HIGH,
      )

    return this.compiler.db.transaction(async cx => {
      // parse / mill errors short-circuit, like the whole-program path
      const merged = await this.compiler.program(cx, this.files)
      if (!merged.ok)
        return { diagnostics: merged.diagnostics.map(toLspDiagnostic) }

      // per definition, concurrently: resolve, then (only if it resolved) type-check. Diagnostics are gathered into a
      // map keyed by the statement index so they assemble in program order, never in completion order (determinism).
      const perDef = await Promise.all(
        merged.program.map(async (statement, index) => {
          if (statement.form !== 'function')
            return {
              index,
              statement,
              diagnostics: [] as Array<LspDiagnostic>,
            }
          const resolved = await this.compiler.resolvedDef(
            cx,
            this.files,
            statement.name,
          )
          if (resolved.diagnostics.length)
            return {
              index,
              statement: resolved.def ?? statement,
              diagnostics: resolved.diagnostics.map(toLspDiagnostic),
            }
          const checked = await this.compiler.typedDef(
            cx,
            this.files,
            statement.name,
          )
          return {
            index,
            statement: checked.def ?? statement,
            diagnostics: checked.diagnostics.map(toLspDiagnostic),
          }
        }),
      )

      const diagnostics: Array<LspDiagnostic> = []
      const typed: Program = []
      for (const entry of perDef) {
        diagnostics.push(...entry.diagnostics)
        typed.push(entry.statement)
      }
      return { diagnostics, program: typed }
    })
  }
}
