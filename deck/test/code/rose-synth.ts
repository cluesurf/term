/**
 * Mutual recursion synthesis: a rose tree (a value and a LIST of child rose
 * trees), whose fold reaches each child through a fold over the child list,
 * synthesized as `combine(value, childrenAgg)`, `merge(acc, childResult)` and
 * `init`.
 *
 * Term since 2026-10-05 (deck/test/code/rose-synthesis.tree, paired against this
 * file's original over 30 specs by tmp/pair-rose.ts). This is its face.
 */

import { foldRose as fold, synthesizeRose as search } from '@term/test/code/rose-synthesis'
import { showExpr, type Expr } from './synthesize'

/** A rose tree: a value and a list of children (mutually recursive ADT). */
export type Rose = { value: number; children: Rose[] }

/** The mutually-recursive fold: tree-fold calls forest-fold calls tree-fold. */
export function foldRose(rose: Rose, combine: Expr, merge: Expr, init: number): number {
  return fold(rose as never, combine, merge, init)
}

export type RoseSynthResult =
  | { ok: true; combine: Expr; merge: Expr; init: number; counterexamples: number }
  | { ok: false; reason: string }

/** Synthesize a rose-tree fold matching `spec` for all rose trees. */
export function synthesizeRose(input: {
  spec: (rose: Rose) => number
  maxSize?: number
  seed?: number
}): RoseSynthResult {
  const found = search(input.spec as never, input.maxSize ?? 3, input.seed ?? 1) as {
    ok: boolean
    combine: Expr
    merge: Expr
    init: number
    counterexamples: number
    reason: string
  }

  return found.ok
    ? { ok: true, combine: found.combine, merge: found.merge, init: found.init, counterexamples: found.counterexamples }
    : { ok: false, reason: found.reason }
}

export { showExpr }
