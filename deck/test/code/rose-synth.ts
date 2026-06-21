/**
 * Mutual recursion synthesis: a rose tree (a node carries a value and a
 * LIST of child rose trees). Folding it is mutually recursive - the
 * tree fold recurses into each child (another tree) by way of a fold
 * over the child list. This is the mutual-recursion frontier beyond the
 * single binary-tree catamorphism (tree-synth.ts).
 *
 * The fold is synthesized as three pieces:
 *   - `combine(value, childrenAgg)`: the node, given its value and the
 *     aggregated result of its children,
 *   - `merge(acc, childResult)`: the forest fold's step over child
 *     results,
 *   - `init`: the forest fold's seed.
 * CEGIS over random rose trees synthesizes all three. (e.g. rose-sum,
 * rose-count.)
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'
import { makeRng, type Rng } from './property'

/** A rose tree: a value and a list of children (mutually recursive ADT). */
export type Rose = { value: number; children: Rose[] }

/** The mutually-recursive fold: tree-fold calls forest-fold calls tree-fold. */
export function foldRose(rose: Rose, combine: Expr, merge: Expr, init: number): number {
  let agg = init
  for (const child of rose.children) {
    agg = evalExpr(merge, [agg, foldRose(child, combine, merge, init)])
  }
  return evalExpr(combine, [rose.value, agg])
}

function randomRose(rng: Rng, depth: number): Rose {
  const count = depth <= 0 ? 0 : Math.floor(rng.next() * 3)
  const children: Rose[] = []
  for (let i = 0; i < count; i++) children.push(randomRose(rng, depth - 1))
  return { value: Math.floor(rng.next() * 10) - 3, children }
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
  const { spec } = input
  const maxSize = input.maxSize ?? 3
  const combines = enumerate(maxSize, 2) // combine(value, childrenAgg)
  const merges = enumerate(maxSize, 2) // merge(acc, childResult)
  const inits = [0, 1]
  const rng = makeRng(input.seed ?? 1)

  const probes: Rose[] = []
  for (let i = 0; i < 250; i++) probes.push(randomRose(rng, 3))

  const counterexamples: Rose[] = []

  for (let round = 0; round <= combines.length * merges.length * inits.length; round++) {
    let pick: { combine: Expr; merge: Expr; init: number } | undefined
    search: for (const init of inits) {
      for (const merge of merges) {
        for (const combine of combines) {
          if (counterexamples.every(t => foldRose(t, combine, merge, init) === spec(t))) {
            pick = { combine, merge, init }
            break search
          }
        }
      }
    }
    if (!pick) return { ok: false, reason: 'no rose fold fits the examples' }

    const counter = probes.find(t => foldRose(t, pick!.combine, pick!.merge, pick!.init) !== spec(t))
    if (!counter) return { ok: true, ...pick, counterexamples: counterexamples.length }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

export { showExpr }
