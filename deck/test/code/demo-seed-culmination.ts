/**
 * The synthesis suite culminating in REAL Seed code. Run from the seed
 * install root:
 *   npx tsx deck/test/code/demo-seed-culmination.ts
 *
 * Each of the four research paradigms (observational-equivalence
 * enumeration, constraint-based exists-forall, stochastic MCMC,
 * sketching) synthesizes a program expression. Every expression is then
 * lowered to a Seed `.tree` task via `emitSeed` and compiled by the
 * LIVE Seed compiler. A paradigm only counts as done when its output is
 * a function the real compiler accepts.
 *
 * This is the whole point of synthesis.md realized: a spec or a set of
 * examples goes in, and verified, compiling Seed comes out, by every
 * synthesis strategy in the literature.
 */

import { projectResolver } from '@cluesurf/call/code/make'
import { compile } from '@cluesurf/make/code/compile/compile'
import {
  observationalEnum,
  constraintSynth,
  stochasticSynth,
  fillSketch,
  type Sketch,
} from './synth-extra'
import { emitSeed } from './emit'
import { showExpr, type Expr, type Spec } from './synthesize'
import { makeSmt } from './smt'

const ROOT = process.cwd()
const resolve = projectResolver(ROOT, 'node', ROOT)
const VAR = (index: number): Expr => ({ form: 'var', index })

/** Lower an Expr to Seed, compile it with the live compiler. */
function emitAndCompile(name: string, params: string[], body: Expr): {
  source: string
  compiles: boolean
} {
  const source = emitSeed({ name, params, body })
  const compiled = compile({ file: `${name}.tree`, text: source }, { resolve })
  return { source, compiles: compiled.ok }
}

async function main(): Promise<void> {
  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  const examples = [[0, 0], [1, 2], [3, 1], [5, 5], [2, 7], [4, 0], [6, 6], [1, 9]]
  const maxTargets = examples.map(([a, b]) => Math.max(a, b))

  // ---- 1. observational-equivalence enum -> Seed ----
  const oe = observationalEnum({ varCount: 2, examples, targets: maxTargets })
  if (oe.ok) {
    const r = emitAndCompile('max-by-enum', ['a', 'b'], oe.expr)
    ok('observational-equivalence enum -> compiling Seed', r.compiles,
      `${showExpr(oe.expr, ['a', 'b'])}`)
    if (r.compiles) console.log(r.source.split('\n').map(l => '    ' + l).join('\n'))
  } else ok('observational-equivalence enum -> compiling Seed', false)

  // ---- 2. constraint-based exists-forall -> Seed ----
  // synthesize f(a,b) = 2a + 3b + 1, then build that expr and emit it.
  let z3
  try { z3 = await makeSmt() } catch { z3 = null }
  if (z3) {
    const affineSpec = (vars: any, out: any) =>
      out.eq(vars[0].mul(2).add(vars[1].mul(3)).add(1))
    const cs = await constraintSynth({ varCount: 2, symSpec: affineSpec, z3 })
    if (cs.ok) {
      // build 2a + 3b + 1 as an Expr from the solved coefficients
      const [ca, cb, cc] = cs.coeffs
      const term = (coeff: number, v: number): Expr => {
        let acc: Expr = VAR(v)
        for (let i = 1; i < coeff; i++) acc = { form: 'add', left: acc, right: VAR(v) }
        return acc
      }
      const body: Expr = {
        form: 'add',
        left: { form: 'add', left: term(ca, 0), right: term(cb, 1) },
        right: { form: 'const', value: cc },
      }
      const r = emitAndCompile('affine-by-smt', ['a', 'b'], body)
      ok('constraint-based exists-forall -> compiling Seed', r.compiles,
        `coeffs ${JSON.stringify(cs.coeffs)} => ${showExpr(body, ['a', 'b'])}`)
    } else ok('constraint-based exists-forall -> compiling Seed', false)
  } else {
    console.log('skip  constraint-based exists-forall (no z3)')
  }

  // ---- 3. stochastic MCMC -> Seed ----
  const st = stochasticSynth({ varCount: 2, examples, targets: maxTargets, seed: 4 })
  if (st.ok) {
    const r = emitAndCompile('max-by-mcmc', ['a', 'b'], st.expr)
    ok('stochastic MCMC -> compiling Seed', r.compiles, `${showExpr(st.expr, ['a', 'b'])}`)
  } else ok('stochastic MCMC -> compiling Seed', false)

  // ---- 4. sketching -> Seed ----
  const sketch: Sketch = (hole) => ({
    form: 'ite',
    test: { form: 'ge', left: hole, right: VAR(1) },
    then: VAR(0),
    else: VAR(1),
  })
  const maxSpec: Spec = ([a, b], out) => out >= a && out >= b && (out === a || out === b)
  const sk = fillSketch({ sketch, varCount: 2, jsSpec: maxSpec })
  if (sk.ok) {
    const r = emitAndCompile('max-by-sketch', ['a', 'b'], sk.expr)
    ok('sketching -> compiling Seed', r.compiles, `${showExpr(sk.expr, ['a', 'b'])}`)
  } else ok('sketching -> compiling Seed', false)

  console.log(`\nseed-verify culmination demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
