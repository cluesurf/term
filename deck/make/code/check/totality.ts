// Totality: strict positivity and termination. The passes are Term, check/termination.tree (self-hosting, 2026-10-06),
// and its header says what each checks. This face hands them the linear prover over a prover state, and keeps the guard
// that turns a failed termination pass into no warnings: a Term guard rethrows a stop before its handler runs, where this
// catch takes every throw. The prover state is the one the caller hands (compile/program-proofs.tree hands the run's,
// ruling 1262 (a) of term/self-host/change/001-finish-self-host, item 1649), else check/refine.ts's process instance.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { refineState } from '@term/make/code/check/refine'
import { provesIn } from '@term/make/code/check/eliminate'
import type { RefineState } from '@term/make/code/check/eliminate'
import type { Inequality } from '@term/make/code/check/certificate'
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

// the linear prover over one prover state
function provesOver(
  state: RefineState,
): (assumptions: Inequality[], goal: Inequality) => boolean {
  return (assumptions, goal) => provesIn(state, assumptions, goal)
}

export function checkTotality(
  program: Program,
  file: string,
  refine: RefineState = refineState,
): TotalityReport {
  const errors = positivityErrors(program, file)

  let warnings: Diagnostic[] = []

  // Termination analysis is best-effort and warnings-only: it must never crash the build. A bug or a malformed or
  // partial AST degrades to "no termination warnings" rather than taking down an otherwise-valid compile. (Positivity
  // above is a soundness error and is intentionally not wrapped.)
  try {
    warnings = terminationWarnings(program, file, provesOver(refine))
  } catch {
    // a failed termination pass yields no warnings, never an error
  }

  return { errors, warnings }
}

// the set of functions whose termination is verified (used to gate transparent definitions in the elaborator)
export function terminatingFunctions(
  program: Program,
  refine: RefineState = refineState,
): Set<string> {
  return new Set(terminatingIn(program, provesOver(refine)))
}
