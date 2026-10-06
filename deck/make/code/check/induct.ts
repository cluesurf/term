// Symbolic Peano induction, the `fold` tactic. The tactic is Term, check/induction.tree (self-hosting, 2026-10-06), and
// its header says what each case proves and why it is sound. This face hands the order goals' product prover in: the
// prover's work budget is module state in check/product.ts, and every case an order goal asks spends from it.

import type { Expression, Program } from '@term/make/code/compile/node'
import { portProves } from '@term/make/code/check/product'
import { checkFold as checkFoldIn, checkFoldOrder as checkFoldOrderIn } from '@term/make/code/check/induction'

// prove `goal` (an `==` expression) by induction on `inductVar`: true iff both the base case and the step are
// discharged by the ring normalizer
export function checkFold(program: Program, goal: Expression, inductVar: string): boolean {
  return checkFoldIn(program, goal, inductVar)
}

// prove an order goal by induction on `n`, given the rule's hypotheses (its `have` guards)
export function checkFoldOrder(program: Program, goal: Expression, n: string, guards: Expression[]): boolean {
  return checkFoldOrderIn(program, goal, n, guards, portProves)
}
