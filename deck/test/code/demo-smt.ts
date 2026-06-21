/**
 * Real, UNBOUNDED proof via Z3. Run (after `pnpm install`):
 *   npx tsx deck/test/code/demo-smt.ts
 *
 * Where ./prove decides a property over a bounded domain, this proves
 * it for ALL integers through the SMT backend. It proves the
 * synthesized bodies (max, abs) meet their specs unboundedly, and
 * returns the exact counterexample for a buggy one.
 *
 * Needs z3-solver. If it is not installed, the demo says so and exits 0.
 */

import { makeSmt, proveExpr, type SymSpec } from './smt'
import { type Expr } from './synthesize'

const VAR = (index: number): Expr => ({ form: 'var', index })
const ZERO: Expr = { form: 'const', value: 0 }

// symbolic specs (Z3 formulas over the input vars and the output term)
const maxSpec: SymSpec = (vars, out, z3) => {
  const [a, b] = vars
  return z3.And(out.ge(a), out.ge(b), z3.Or(out.eq(a), out.eq(b)))
}
const absSpec: SymSpec = (vars, out, z3) => {
  const [a] = vars
  return z3.And(out.ge(z3.Int.val(0)), z3.Or(out.eq(a), out.eq(a.neg())))
}

async function main(): Promise<void> {
  let z3
  try {
    z3 = await makeSmt()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify SMT demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // max(a, b) proven correct for ALL integers
  const maxExpr: Expr = { form: 'max', left: VAR(0), right: VAR(1) }
  const maxResult = await proveExpr({ arity: 2, expr: maxExpr, spec: maxSpec, z3 })
  ok('max(a,b) proven for ALL integers (unbounded)', maxResult.proven)

  // abs(a) = max(a, 0 - a) proven correct for ALL integers
  const absExpr: Expr = { form: 'max', left: VAR(0), right: { form: 'sub', left: ZERO, right: VAR(0) } }
  const absResult = await proveExpr({ arity: 1, expr: absExpr, spec: absSpec, z3 })
  ok('abs(a) = max(a, -a) proven for ALL integers', absResult.proven)

  // a buggy "max" (returns a) is refuted with a concrete counterexample
  const buggyMax: Expr = VAR(0)
  const buggyResult = await proveExpr({ arity: 2, expr: buggyMax, spec: maxSpec, z3 })
  ok('buggy max refuted with a counterexample',
    !buggyResult.proven && 'counterexample' in buggyResult,
    !buggyResult.proven && 'counterexample' in buggyResult
      ? `[a,b]=${JSON.stringify(buggyResult.counterexample)}` : '')

  console.log(`\nseed-verify SMT demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
