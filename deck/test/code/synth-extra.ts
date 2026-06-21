/**
 * The program-synthesis algorithm suite from synthesis.md, beyond the
 * CEGIS already built (synthesize.ts / synth-smt.ts). Four distinct
 * paradigms from the research:
 *
 *   1. observationalEnum - bottom-up enumeration with OBSERVATIONAL
 *      EQUIVALENCE pruning (Udupa et al.): keep one program per distinct
 *      behavior on the examples. The standard fast enumerative synth.
 *   2. constraintSynth - CONSTRAINT-BASED / SyGuS single-query: a
 *      parameterized template + Z3 ForAll solves "exists params. forall
 *      inputs. spec" in one shot (not the iterative CEGIS loop).
 *   3. stochasticSynth - STOCHASTIC (MCMC / Metropolis-Hastings,
 *      STOKE-style): random walk over programs scored by examples
 *      satisfied, accepting by the MH criterion.
 *   4. fillSketch - SKETCHING (Solar-Lezama): a program with a HOLE;
 *      synthesize the hole's sub-expression so the whole meets the spec.
 *
 * All over the integer-expression grammar (synthesize.ts). PBE
 * (programming-by-example) is CEGIS with examples as the spec - already
 * covered. Component-based composition is the enumerator restricted to a
 * component set.
 */

import { enumerate, evalExpr, type Expr, type Spec } from './synthesize'
import { makeRng } from './property'

// ---------------------------------------------------------------------
// 1. Bottom-up enumeration with observational equivalence
// ---------------------------------------------------------------------

/** Synthesize by enumerating programs and pruning those behaviorally
 * identical to one already seen on the example inputs. Returns the first
 * program whose behavior matches `targets` on `examples`. */
export function observationalEnum(input: {
  varCount: number
  examples: number[][]
  targets: number[]
  maxSize?: number
}): { ok: true; expr: Expr; pruned: number } | { ok: false } {
  const { examples, targets } = input
  const candidates = enumerate(input.maxSize ?? 6, input.varCount)
  const seen = new Set<string>()
  let pruned = 0

  for (const expr of candidates) {
    const behavior = examples.map(e => evalExpr(expr, e))
    const sig = behavior.join(',')
    if (seen.has(sig)) {
      pruned++
      continue // observationally equivalent to a kept program - skip
    }
    seen.add(sig)
    if (behavior.every((v, i) => v === targets[i])) return { ok: true, expr, pruned }
  }
  return { ok: false }
}

// ---------------------------------------------------------------------
// 2. Constraint-based / SyGuS single-query (exists params. forall inputs)
// ---------------------------------------------------------------------

type Z3 = any

/** Synthesize an AFFINE program (c0*x0 + c1*x1 + ... + ck) by asking Z3
 * for coefficients satisfying the spec for ALL inputs in ONE query
 * (exists coefficients. forall inputs. spec). The coefficients ARE the
 * synthesized program. `symSpec` builds the goal from the inputs and the
 * affine output term. */
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

// ---------------------------------------------------------------------
// 3. Stochastic synthesis (MCMC / Metropolis-Hastings, STOKE-style)
// ---------------------------------------------------------------------

/** Score = fraction of examples a program gets right. */
function score(expr: Expr, examples: number[][], targets: number[]): number {
  let hits = 0
  for (let i = 0; i < examples.length; i++) {
    if (evalExpr(expr, examples[i]) === targets[i]) hits++
  }
  return hits / examples.length
}

/** Synthesize by a Metropolis-Hastings random walk over programs:
 * propose a neighbor, accept by exp((s'-s)/T). Cooling T over time.
 * Returns a program matching all examples if found. */
export function stochasticSynth(input: {
  varCount: number
  examples: number[][]
  targets: number[]
  iterations?: number
  seed?: number
  maxSize?: number
}): { ok: true; expr: Expr; iterations: number } | { ok: false } {
  const { varCount, examples, targets } = input
  const iterations = input.iterations ?? 200_000
  const rng = makeRng(input.seed ?? 1)
  const pool = enumerate(input.maxSize ?? 5, varCount) // the move space

  let current = pool[Math.floor(rng.next() * pool.length)]
  let currentScore = score(current, examples, targets)

  for (let i = 0; i < iterations; i++) {
    if (currentScore === 1) return { ok: true, expr: current, iterations: i }
    const temp = Math.max(0.05, 1 - i / iterations)
    const proposal = pool[Math.floor(rng.next() * pool.length)]
    const ps = score(proposal, examples, targets)
    // Metropolis-Hastings accept
    if (ps >= currentScore || rng.next() < Math.exp((ps - currentScore) / temp)) {
      current = proposal
      currentScore = ps
    }
  }
  return currentScore === 1 ? { ok: true, expr: current, iterations } : { ok: false }
}

// ---------------------------------------------------------------------
// 4. Sketching (a program with a hole; synthesize the hole)
// ---------------------------------------------------------------------

/** A sketch: a program with one hole, given as a function from the
 * hole's filler expression to the complete program. */
export type Sketch = (hole: Expr) => Expr

/** Fill a sketch's hole so the completed program satisfies `spec` over
 * the bounded domain. Enumerate hole-fillers; the rest of the program is
 * fixed by the sketch. */
export function fillSketch(input: {
  sketch: Sketch
  varCount: number
  jsSpec: Spec
  maxSize?: number
  bound?: number
}): { ok: true; hole: Expr; expr: Expr } | { ok: false } {
  const { sketch, varCount, jsSpec } = input
  const bound = input.bound ?? 6
  const fillers = enumerate(input.maxSize ?? 4, varCount)

  for (const hole of fillers) {
    const expr = sketch(hole)
    if (provedOverBound(varCount, bound, inputs => jsSpec(inputs, evalExpr(expr, inputs)))) {
      return { ok: true, hole, expr }
    }
  }
  return { ok: false }
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
