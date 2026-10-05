/**
 * Synthesis over structured outputs and recursion - a step from the
 * scalar grammar toward the full Seed IR.
 *
 *   - synthesizeTuple: a function returning a TUPLE, each component
 *     synthesized from its own spec. (e.g. minmax -> (min, max))
 *   - synthesizeFold: a RECURSIVE function over a list, synthesized as a
 *     fold step `step(acc, elem)`. (e.g. sum, length)
 *
 * Term since 2026-10-05 (deck/test/code/fold-synthesis.tree, paired against
 * this file's original over 80 syntheses by tmp/pair-fold.ts). This is its face.
 */

import {
  runFold as fold,
  synthesizeFold as searchFold,
  synthesizeTuple as searchTuple,
} from '@term/test/code/fold-synthesis'
import { showExpr, type Expr } from './synthesize'

export type TupleResult =
  | { ok: true; exprs: Expr[] }
  | { ok: false; reason: string }

/** Synthesize a function whose output is a tuple; `specs[i]` constrains component i. */
export function synthesizeTuple(input: {
  varCount: number
  specs: ((inputs: number[], out: number) => boolean)[]
  maxSize?: number
  bound?: number
}): TupleResult {
  const found = searchTuple(input.varCount, input.specs as never, input.maxSize ?? 5, input.bound ?? 6) as {
    ok: boolean
    exprs: Expr[]
    reason: string
  }

  return found.ok ? { ok: true, exprs: found.exprs } : { ok: false, reason: found.reason }
}

/** Fold a list with a synthesized step over (acc, elem). */
export function runFold(step: Expr, init: number, list: number[]): number {
  return fold(step, init, list)
}

export type FoldResult =
  | { ok: true; step: Expr; init: number; counterexamples: number[][] }
  | { ok: false; reason: string }

/** Synthesize a recursive list function as a fold step from `init`. */
export function synthesizeFold(input: {
  init: number
  spec: (list: number[]) => number
  maxSize?: number
  seed?: number
}): FoldResult {
  const found = searchFold(input.init, input.spec, input.maxSize ?? 5, input.seed ?? 1) as {
    ok: boolean
    step: Expr
    init: number
    counterexamples: number[][]
    reason: string
  }

  return found.ok
    ? { ok: true, step: found.step, init: found.init, counterexamples: found.counterexamples }
    : { ok: false, reason: found.reason }
}

export { showExpr }
