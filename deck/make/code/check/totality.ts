// Totality: strict positivity and termination. The passes are Term, check/termination.tree (self-hosting, 2026-10-06),
// and its header says what each checks. This face hands them the linear prover (check/refine.ts, whose memo and count
// are module state), tells them whether a match arm wrote its `binds`, and keeps the guard that turns a failed
// termination pass into no warnings.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { proves } from '@term/make/code/check/refine'
import {
  positivityErrors,
  terminatingFunctions as terminatingIn,
  terminationWarnings,
} from '@term/make/code/check/termination'
import type { Program } from '@term/make/code/compile/node'

export type TotalityReport = {
  errors: Diagnostic[]
  warnings: Diagnostic[]
}

// an arm that wrote its `binds` reads no variant's fields, even when the list is empty
export const bindsGiven = (arm: { binds?: string[] }): boolean => arm.binds !== undefined

export function checkTotality(
  program: Program,
  file: string,
): TotalityReport {
  const errors = positivityErrors(program, file)
  let warnings: Diagnostic[] = []

  // Termination analysis is best-effort and warnings-only: it must never crash the build. A bug or a malformed or
  // partial AST degrades to "no termination warnings" rather than taking down an otherwise-valid compile. (Positivity
  // above is a soundness error and is intentionally not wrapped.)
  try {
    warnings = terminationWarnings(program, file, proves, bindsGiven)
  } catch {
    // a failed termination pass yields no warnings, never an error
  }

  return { errors, warnings }
}

// the set of functions whose termination is verified (used to gate transparent definitions in the elaborator)
export function terminatingFunctions(program: Program): Set<string> {
  return new Set(terminatingIn(program, proves, bindsGiven))
}
