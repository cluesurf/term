/**
 * Synthesis over structured outputs and recursion - a step from the
 * scalar grammar toward the full Seed IR.
 *
 *   - synthesizeTuple: a function returning a TUPLE/record, each
 *     component synthesized from its own spec. (e.g. minmax -> (min, max))
 *   - synthesizeFold: a RECURSIVE function over a list, synthesized as a
 *     fold - find the step `step(acc, elem)` (and the init) so that
 *     folding it over any list matches the spec. The fold realizes the
 *     recursion; CEGIS synthesizes the step. (e.g. sum, length)
 *
 * Both reuse the integer-expression grammar and the CEGIS loop; the new
 * part is the output shape (a tuple) and the recursion scheme (a fold).
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'
import { makeRng } from './property'

// --- structured (tuple) outputs ---

export type TupleResult =
  | { ok: true; exprs: Expr[] }
  | { ok: false; reason: string }

/**
 * Synthesize a function whose output is a tuple. `specs[i]` constrains
 * component i given the inputs. Each component is synthesized
 * independently over the shared inputs.
 */
export function synthesizeTuple(input: {
  varCount: number
  specs: ((inputs: number[], out: number) => boolean)[]
  maxSize?: number
  bound?: number
}): TupleResult {
  const { varCount, specs } = input
  const maxSize = input.maxSize ?? 5
  const bound = input.bound ?? 6
  const candidates = enumerate(maxSize, varCount)
  const exprs: Expr[] = []

  for (const spec of specs) {
    const pick = candidates.find(expr => provedOverBound(varCount, bound, inputs => spec(inputs, evalExpr(expr, inputs))))
    if (!pick) return { ok: false, reason: 'a component had no fit in the grammar' }
    exprs.push(pick)
  }
  return { ok: true, exprs }
}

function provedOverBound(arity: number, bound: number, holds: (inputs: number[]) => boolean): boolean {
  const point = new Array<number>(arity).fill(-bound)
  for (;;) {
    if (!holds(point)) return false
    let i = arity - 1
    for (; i >= 0; i--) {
      if (point[i] < bound) { point[i]++; break }
      point[i] = -bound
    }
    if (i < 0) return true
  }
}

// --- recursion via fold ---

/** Fold a list with a synthesized step over (acc, elem). */
export function runFold(step: Expr, init: number, list: number[]): number {
  let acc = init
  for (const elem of list) acc = evalExpr(step, [acc, elem])
  return acc
}

export type FoldResult =
  | { ok: true; step: Expr; init: number; counterexamples: number[][] }
  | { ok: false; reason: string }

/**
 * Synthesize a recursive list function as a fold: find a step
 * `step(acc, elem)` so that `fold(list, init, step)` equals `spec(list)`
 * for all lists. CEGIS over lists - a list where the candidate folds
 * wrong is the counterexample that refines the search.
 */
export function synthesizeFold(input: {
  init: number
  spec: (list: number[]) => number
  maxSize?: number
  seed?: number
}): FoldResult {
  const { init, spec } = input
  const maxSize = input.maxSize ?? 5
  // step is over two vars: acc (var 0) and elem (var 1)
  const candidates = enumerate(maxSize, 2)
  const counterexamples: number[][] = []
  const rng = makeRng(input.seed ?? 1)

  for (let round = 0; round <= candidates.length; round++) {
    const pick = candidates.find(step =>
      counterexamples.every(list => runFold(step, init, list) === spec(list)),
    )
    if (!pick) return { ok: false, reason: 'no fold step fits the examples' }

    // verify on many random lists; a mismatch is a counterexample list
    let counter: number[] | null = null
    for (let i = 0; i < 400; i++) {
      const len = Math.floor(rng.next() * 6)
      const list = Array.from({ length: len }, () => Math.floor(rng.next() * 10) - 2)
      if (runFold(pick, init, list) !== spec(list)) { counter = list; break }
    }
    if (!counter) return { ok: true, step: pick, init, counterexamples }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

export { showExpr }
