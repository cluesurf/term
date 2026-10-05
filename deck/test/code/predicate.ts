/**
 * Synthesis beyond integer arithmetic: boolean-valued PREDICATES. A
 * step in lifting CEGIS off the integer-expression grammar toward the
 * full Seed IR. The grammar is comparisons over the integer expressions
 * combined with boolean connectives, so the synthesizer can now produce
 * functions like `in-range`, `is-positive`, `ordered`.
 *
 * Term since 2026-10-04: deck/test/code/predicate-synthesis.tree. This
 * keeps the defaults its TypeScript callers (recursion.ts, the demo)
 * leave out: expressions of up to 2 nodes, predicates of up to 3, a
 * bound of 6.
 */

import { enumeratePreds as enumerateAll, evalPred, showPred, synthesizePred as synthesizeAll } from '@term/test/code/predicate-synthesis'
import type { Predicate, PredicateResult } from '@term/test/code/predicate-synthesis'

/** A boolean predicate over the integer inputs. */
export type Pred = Predicate

/** A boolean spec: does this predicate's value match the intended one? */
export type PredSpec = (inputs: number[], out: boolean) => boolean

export type PredSynthResult = PredicateResult

export { evalPred, showPred }

/** Enumerate predicates up to a size: atoms (comparisons of small exprs)
 * combined by and/or/not. Smallest first. */
export function enumeratePreds(varCount: number, exprSize = 2, predSize = 3): Pred[] {
  return enumerateAll(varCount, exprSize, predSize)
}

/** CEGIS for predicates: smallest predicate consistent with the
 * counterexamples, verified exhaustively over the bound, refined on
 * failure. */
export function synthesizePred(input: {
  varCount: number
  spec: PredSpec
  bound?: number
  exprSize?: number
  predSize?: number
}): PredSynthResult {
  return synthesizeAll(input.varCount, input.spec, input.bound ?? 6, input.exprSize ?? 2, input.predSize ?? 3)
}
