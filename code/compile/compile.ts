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
import { checkHolds } from '@/code/check/holds'
import { checkTraits } from '@/code/check/traits'
import { simplify } from '@/code/ir/simplify'
import { emitTypeScript } from '@/code/compile/typescript'
import type { Program } from '@/code/compile/node'

export type CompileResult =
  | { ok: true; program: Program; typescript: string }
  | { ok: false; diagnostics: Array<Diagnostic> }

export function compile(source: { file: string; text: string }): CompileResult {
  const parsed = parse(source)
  if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics }

  // expand phase: tree/fuse templates, so injected code goes through the mill, resolver, and type checker
  const expanded = expandTemplates(parsed.tree)

  const built = mill(expanded, source.file)
  if (!built.ok) return { ok: false, diagnostics: built.diagnostics }

  // hole-filling: bind names to definitions
  const resolveDiagnostics = resolve(built.program, source.file)
  if (resolveDiagnostics.length) return { ok: false, diagnostics: resolveDiagnostics }

  // formal type checking
  const checkDiagnostics = check(built.program, source.file)
  if (checkDiagnostics.length) return { ok: false, diagnostics: checkDiagnostics }

  // trait checking: instance completeness and trait-bound existence
  const traitDiagnostics = checkTraits(built.program, source.file)
  if (traitDiagnostics.length) return { ok: false, diagnostics: traitDiagnostics }

  // refinement layer 2: discharge `hold` verification conditions
  const holdDiagnostics = checkHolds(built.program, source.file)
  if (holdDiagnostics.length) return { ok: false, diagnostics: holdDiagnostics }

  // IR pass: simplify (constant folding, algebraic identities)
  const optimized = simplify(built.program)

  return { ok: true, program: optimized, typescript: emitTypeScript(optimized) }
}
