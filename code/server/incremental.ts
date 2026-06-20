// The incremental analyzer: the editor/dev front-end on the query-engine compiler (`QueryCompiler`). Where `analyze`
// recompiles the whole program on every edit, this re-checks only the definitions that actually changed (the signature
// firewall), so a keystroke re-types one function, not the project. It produces the same LSP diagnostics plus a typed
// program (assembled from the per-definition typed clones) for navigation / hover.
// See note/seed/plan/functional-checker.md and compilation-performance.md (Tier 2).

import { QueryCompiler } from '@/code/compile/incremental'
import { LOW, HIGH } from '@/code/compile/query'
import { collectModules } from '@/code/compile/load'
import type { Resolver, Source } from '@/code/compile/load'
import type { Program } from '@/code/compile/node'
import { toLspDiagnostic } from '@/code/server/analyze'
import type { LspDiagnostic } from '@/code/server/analyze'

export class IncrementalAnalyzer {
  // public for stats / tests (the query database tracks per-key recompute counts)
  readonly compiler = new QueryCompiler()
  private files: Array<string> = []

  constructor(private readonly resolve?: Resolver) {}

  // analyze a document: collect its module graph, set sources, return incremental diagnostics + the typed program
  analyze(document: Source): {
    diagnostics: Array<LspDiagnostic>
    program?: Program
  } {
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

    // parse / mill errors short-circuit, like the whole-program path
    const merged = this.compiler.program(this.files)
    if (!merged.ok)
      return { diagnostics: merged.diagnostics.map(toLspDiagnostic) }

    // per definition: resolve, then (only if it resolved) type-check. Assemble the typed program for navigation.
    const diagnostics: Array<LspDiagnostic> = []
    const typed: Program = merged.program.map(statement => {
      if (statement.form !== 'function') return statement
      const resolved = this.compiler.resolvedDef(this.files, statement.name)
      if (resolved.diagnostics.length) {
        diagnostics.push(...resolved.diagnostics.map(toLspDiagnostic))
        return resolved.def ?? statement
      }
      const checked = this.compiler.typedDef(this.files, statement.name)
      diagnostics.push(...checked.diagnostics.map(toLspDiagnostic))
      return checked.def ?? statement
    })
    return { diagnostics, program: typed }
  }
}
