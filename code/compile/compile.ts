// The compile driver: source text to nice TypeScript, through parse, mill, resolve, check, and emit. Pure and
// browser-safe: returns the program (compile AST) and the emitted TypeScript. Running the result is a separate
// step (write the module and import it, hot-module-reload style).
// Pipeline: parse -> mill (mine/mint) -> resolve (fill name holes) -> check (types) -> emit.
// See note/research/vibe/computation/plans/11-elaboration.md.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { parse } from '@/code/parser/tree'
import { expandTemplates } from '@/code/compile/template'
import { mill } from '@/code/compile/mill'
import { resolve } from '@/code/check/resolve'
import { check } from '@/code/check/infer'
import { elaborateReport } from '@/code/check/elaborate'
import { checkHolds } from '@/code/check/holds'
import { checkTraits } from '@/code/check/traits'
import { checkEffects } from '@/code/check/effects'
import { checkTotality } from '@/code/check/totality'
import { findUnused } from '@/code/check/unused'
import { simplify } from '@/code/ir/simplify'
import { emitTypeScript } from '@/code/compile/typescript'
import { collectModules } from '@/code/compile/load'
import type { Resolver } from '@/code/compile/load'
import type { Program } from '@/code/compile/node'

export type CompileResult =
  | { ok: true; program: Program; typescript: string; warnings: Array<Diagnostic> }
  | { ok: false; diagnostics: Array<Diagnostic> }

export function compile(source: { file: string; text: string }, options?: { resolve?: Resolver }): CompileResult {
  // collect the entry plus every module it loads (so the stdlib supplies the form definitions), dependencies
  // first, then mill each and merge into one program. Without a resolver this is just the single entry file.
  const sources = options?.resolve ? collectModules(source, options.resolve).sources : [source]
  const program: Program = []
  for (const unit of sources) {
    const parsed = parse(unit)
    if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics }
    // expand phase: tree/fuse templates, so injected code goes through the mill, resolver, and type checker
    const built = mill(expandTemplates(parsed.tree), unit.file)
    if (!built.ok) return { ok: false, diagnostics: built.diagnostics }
    program.push(...built.program)
  }

  // hole-filling: bind names to definitions
  const resolveDiagnostics = resolve(program, source.file)
  if (resolveDiagnostics.length) return { ok: false, diagnostics: resolveDiagnostics }

  // formal type checking: the surface pass (gradual bidirectional inference) annotates the AST with types
  const checkDiagnostics = check(program, source.file)
  if (checkDiagnostics.length) return { ok: false, diagnostics: checkDiagnostics }

  // elaboration: lower the now-typed surface into the sound dependent kernel and let it verify. The kernel is the
  // single type-theoretic authority; the surface pass above is its inference front-end. See plans/12-type-systems.
  // It also discharges non-linear `hold` clauses by definitional equality (the kernel fallback for refinement).
  const elaboration = elaborateReport(program, source.file)
  if (elaboration.diagnostics.length) return { ok: false, diagnostics: elaboration.diagnostics }
  const kernelDischarged = new Set(elaboration.discharged.map((s) => `${s.start.line}:${s.start.column}`))

  // trait checking: instance completeness and trait-bound existence
  const traitDiagnostics = checkTraits(program, source.file)
  if (traitDiagnostics.length) return { ok: false, diagnostics: traitDiagnostics }

  // effect checking: async / await discipline (the surface slice of the effect system)
  const effectDiagnostics = checkEffects(program, source.file)
  if (effectDiagnostics.length) return { ok: false, diagnostics: effectDiagnostics }

  // refinement layer 2: discharge `hold` verification conditions. The linear prover handles the linear fragment;
  // holds the kernel already proved by definitional equality are dropped. Unprovable holds are errors; holds
  // outside the decidable fragment (and not kernel-discharged) are warnings (flagged, not silently skipped).
  const holdDiagnostics = checkHolds(program, source.file).filter(
    (d) => !d.markers.some((m) => kernelDischarged.has(`${m.span.start.line}:${m.span.start.column}`)),
  )
  const holdErrors = holdDiagnostics.filter((d) => d.severity === 'error')
  if (holdErrors.length) return { ok: false, diagnostics: holdErrors }
  const holdWarnings = holdDiagnostics.filter((d) => d.severity === 'warning')

  // totality: strict positivity (hard error) keeps datatypes sound; termination (warning) flags recursion we
  // cannot show well-founded. Both are prerequisites for soundly making definitions proof-relevant.
  const totality = checkTotality(program, source.file)
  if (totality.errors.length) return { ok: false, diagnostics: totality.errors }

  // IR pass: simplify (constant folding, algebraic identities)
  const optimized = simplify(program)

  // warnings do not fail the build (unused bindings, termination, unchecked holds, etc.)
  const warnings = [...findUnused(program, source.file), ...totality.warnings, ...holdWarnings]

  return { ok: true, program: optimized, typescript: emitTypeScript(optimized), warnings }
}
