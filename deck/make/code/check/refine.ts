// Refinement-type verification: the linear prover. The search is Term, check/eliminate.tree (self-hosting,
// 2026-10-06), and its header says how it decides. Its state, the satisfiability memo and the count of answers whose
// certificate did not replay, is eliminate.tree's `refine-state` (item 0355, decision 057): this face holds and exports
// the one instance, which holds.ts, twin.ts and totality.ts share as they shared the module state.

import {
  above,
  atLeast,
  atMost,
  below,
  freshRefineState,
  noteUncertified as noteUncertifiedIn,
  provesIn,
} from '@term/make/code/check/eliminate'
import type { RefineState } from '@term/make/code/check/eliminate'
import type { Inequality } from '@term/make/code/check/certificate'

export { above, atLeast, atMost, below }

// a linear expression: sum of coefficient * variable, plus a constant
export type Linear = { terms: Map<string, number>; constant: number }

export function linear(
  terms: Record<string, number>,
  constant = 0,
): Linear {
  return { terms: new Map(Object.entries(terms)), constant }
}

// THE PROVER'S STATE: one per process (spec 4.8)
export const refineState: RefineState = freshRefineState()

export function uncertifiedCount(): number {
  return refineState.uncertified
}

// a polynomial prover's answer that its Gram certificate did not confirm (holds.ts certified), counted the same way
export function noteUncertified(): void {
  noteUncertifiedIn(refineState)
}

// does the conjunction of assumptions imply the goal? (eliminate.tree `proves-in`)
export function proves(
  assumptions: Inequality[],
  goal: Inequality,
): boolean {
  return provesIn(refineState, assumptions, goal)
}
