/**
 * The full program-synthesis algorithm suite. Run:
 *   npx tsx deck/test/code/demo-synth-extra.ts
 *
 * Four distinct synthesis paradigms, each solving a problem:
 *   1. observational-equivalence enumeration  (fast enumerative)
 *   2. constraint-based / SyGuS exists-forall  (Z3 single query)
 *   3. stochastic MCMC                          (Metropolis-Hastings)
 *   4. sketching                                (fill a hole)
 *
 * Needs z3-solver for #2; the rest are pure.
 */

import {
  observationalEnum,
  constraintSynth,
  stochasticSynth,
  fillSketch,
  type Sketch,
} from './synth-extra'
import { showExpr, evalExpr, type Expr, type Spec } from './synthesize'
import { makeSmt } from './smt'

const VAR = (i: number): Expr => ({ form: 'var', index: i })

async function main(): Promise<void> {
  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // shared example set for the example-driven algorithms
  const examples = [[0, 0], [1, 2], [3, 1], [5, 5], [2, 7], [4, 0], [6, 6], [1, 9]]

  // ---- 1. observational-equivalence enumeration: synthesize max ----
  const maxTargets = examples.map(([a, b]) => Math.max(a, b))
  const oe = observationalEnum({ varCount: 2, examples, targets: maxTargets })
  ok('observational-equivalence enum synthesizes max', oe.ok,
    oe.ok ? `=> ${showExpr(oe.expr, ['a', 'b'])} (pruned ${oe.pruned} equivalent programs)` : '')

  // ---- 2. constraint-based / SyGuS: synthesize an affine function ----
  // target: f(a,b) = 2a + 3b + 1. spec: out == 2a + 3b + 1, for ALL inputs.
  let z3
  try { z3 = await makeSmt() } catch { z3 = null }
  if (z3) {
    const affineSpec = (vars: any, out: any, z: any) =>
      out.eq(vars[0].mul(2).add(vars[1].mul(3)).add(1))
    const cs = await constraintSynth({ varCount: 2, symSpec: affineSpec, z3 })
    ok('constraint-based (exists-forall) synthesizes 2a+3b+1', cs.ok,
      cs.ok ? `=> coeffs [a,b,const] = ${JSON.stringify(cs.coeffs)}` : '')
  } else {
    console.log('skip  constraint-based (no z3)')
  }

  // ---- 3. stochastic MCMC: synthesize max from examples ----
  const st = stochasticSynth({ varCount: 2, examples, targets: maxTargets, seed: 4 })
  ok('stochastic MCMC synthesizes max', st.ok,
    st.ok ? `=> ${showExpr(st.expr, ['a', 'b'])} (${st.iterations} steps)` : '')

  // ---- 4. sketching: fill the hole in `if ?? then a else b` to get max ----
  // sketch: ite(hole, a, b). Filling hole = (a >= b) gives max.
  const sketch: Sketch = (hole) => ({
    form: 'ite',
    test: { form: 'ge', left: hole, right: VAR(1) }, // hole >= b
    then: VAR(0),
    else: VAR(1),
  })
  const maxSpec: Spec = ([a, b], out) => out >= a && out >= b && (out === a || out === b)
  const sk = fillSketch({ sketch, varCount: 2, jsSpec: maxSpec })
  ok('sketching fills the hole to complete max', sk.ok,
    sk.ok ? `=> hole = ${showExpr(sk.hole, ['a', 'b'])}, full = ${showExpr(sk.expr, ['a', 'b'])}` : '')

  console.log(`\nseed-verify synth-extra demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
