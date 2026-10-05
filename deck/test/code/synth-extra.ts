/**
 * The program-synthesis algorithm suite from synthesis.md, beyond the
 * CEGIS already built (synthesize.ts / synth-smt.ts). Four distinct
 * paradigms from the research:
 *
 *   1. observationalEnum - bottom-up enumeration with OBSERVATIONAL
 *      EQUIVALENCE pruning (Udupa et al.)
 *   2. constraintSynth - CONSTRAINT-BASED / SyGuS single-query: a
 *      parameterized template + Z3 ForAll solves "exists params. forall
 *      inputs. spec" in one shot
 *   3. stochasticSynth - STOCHASTIC (MCMC / Metropolis-Hastings, STOKE-style)
 *   4. fillSketch - SKETCHING (Solar-Lezama): a program with a HOLE
 *
 * 1, 3 and 4 are Term since 2026-10-05 (deck/test/code/synthesis-suite.tree,
 * paired against this file's original over 90 syntheses by tmp/pair-suite.ts),
 * and this is their face. 2 is Term too (deck/test/code/affine-synthesis.tree,
 * paired over 60 specs by tmp/pair-affine.ts), and stays here for its callers,
 * whose spec is a closure over Z3's JavaScript expressions.
 */

import {
  observationalEnum as enumerateObserved,
  stochasticSynth as walk,
  fillSketch as fill,
} from '@term/test/code/synthesis-suite'
import { type Expr, type Spec } from './synthesize'

/** Synthesize by enumerating programs and pruning those behaviorally
 * identical to one already seen on the example inputs. */
export function observationalEnum(input: {
  varCount: number
  examples: number[][]
  targets: number[]
  maxSize?: number
}): { ok: true; expr: Expr; pruned: number } | { ok: false } {
  const found = enumerateObserved(input.varCount, input.examples, input.targets, input.maxSize ?? 6) as {
    ok: boolean
    expr: Expr
    pruned: number
  }

  return found.ok ? { ok: true, expr: found.expr, pruned: found.pruned } : { ok: false }
}

type Z3 = any

/** Synthesize an AFFINE program (c0*x0 + c1*x1 + ... + ck) by asking Z3
 * for coefficients satisfying the spec for ALL inputs in ONE query
 * (exists coefficients. forall inputs. spec). */
export async function constraintSynth(input: {
  varCount: number
  symSpec: (vars: Z3[], out: Z3, z3: Z3) => Z3
  z3: Z3
  coeffBound?: number
}): Promise<{ ok: true; coeffs: number[] } | { ok: false }> {
  const { varCount, symSpec, z3 } = input
  const bound = input.coeffBound ?? 5

  // coefficients (the program's parameters) - existentially chosen
  const coeffs = Array.from({ length: varCount + 1 }, (_, i) => z3.Int.const(`c${i}`))
  // universally-quantified inputs
  const xs = Array.from({ length: varCount }, (_, i) => z3.Int.const(`x${i}`))

  // affine output: c0*x0 + ... + c_{n-1}*x_{n-1} + c_n
  let out = coeffs[varCount]
  for (let i = 0; i < varCount; i++) out = out.add(coeffs[i].mul(xs[i]))

  const solver = new z3.Solver()
  // keep coefficients small (search space) and the spec hold for all inputs
  for (const c of coeffs) solver.add(z3.And(c.ge(-bound), c.le(bound)))
  solver.add(z3.ForAll(xs, symSpec(xs, out, z3)))

  if ((await solver.check()) !== 'sat') return { ok: false }
  const model = solver.model()
  const read = (t: Z3) => Number(String(model.eval(t, true)).replace(/^\(-\s*(\d+)\)$/, '-$1'))
  return { ok: true, coeffs: coeffs.map(read) }
}

/** Synthesize by a Metropolis-Hastings random walk over programs. */
export function stochasticSynth(input: {
  varCount: number
  examples: number[][]
  targets: number[]
  iterations?: number
  seed?: number
  maxSize?: number
}): { ok: true; expr: Expr; iterations: number } | { ok: false } {
  const found = walk(
    input.varCount,
    input.examples,
    input.targets,
    input.iterations ?? 200_000,
    input.seed ?? 1,
    input.maxSize ?? 5,
  ) as { ok: boolean; expr: Expr; iterations: number }

  return found.ok ? { ok: true, expr: found.expr, iterations: found.iterations } : { ok: false }
}

/** A sketch: a program with one hole, given as a function from the
 * hole's filler expression to the complete program. */
export type Sketch = (hole: Expr) => Expr

/** Fill a sketch's hole so the completed program satisfies `spec` over the bounded domain. */
export function fillSketch(input: {
  sketch: Sketch
  varCount: number
  jsSpec: Spec
  maxSize?: number
  bound?: number
}): { ok: true; hole: Expr; expr: Expr } | { ok: false } {
  const found = fill(input.sketch as never, input.varCount, input.jsSpec, input.maxSize ?? 4, input.bound ?? 6) as {
    ok: boolean
    hole: Expr
    expr: Expr
  }

  return found.ok ? { ok: true, hole: found.hole, expr: found.expr } : { ok: false }
}
