/**
 * The performance keys, runnable. Run from the seed install root:
 *   npx tsx deck/test/code/demo-perf.ts
 *
 *   1. SMT session reuse - one warm solver proves many obligations via
 *      push/pop instead of a fresh solver per obligation.
 *   2. Parallel proving - independent obligations prove concurrently
 *      (the async Z3 path overlaps), faster wall-clock than serial.
 *
 * (BDD variable reordering, the third key, has its own demo:
 *  demo-bdd-reorder.ts.)
 *
 * Needs z3-solver. The parallel-vs-serial timing is reported; the test
 * asserts correctness, and that concurrency did not lose or reorder any
 * result.
 */

import { makeSmt, openSmtSession, type SymSpec } from './smt'
import { mapConcurrent } from './parallel'
import type { Expr } from './synthesize'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const VAR = (index: number): Expr => ({ form: 'var', index })

async function main(): Promise<void> {
  let z3
  try { z3 = await makeSmt() } catch { z3 = null }
  if (!z3) {
    console.log('skip  perf demo (no z3)')
    return
  }

  // spec: out >= a && out >= b && (out == a || out == b)  (i.e. out == max(a,b))
  const maxSpec: SymSpec = (vars, out, z) =>
    z.And(out.ge(vars[0]), out.ge(vars[1]), z.Or(out.eq(vars[0]), out.eq(vars[1])))

  const maxExpr: Expr = { form: 'max', left: VAR(0), right: VAR(1) }
  const wrongExpr: Expr = VAR(0) // "return a" - not max

  // ---- 1. session reuse: one solver, many obligations via push/pop ----
  const session = openSmtSession({ z3, arity: 2 })
  const r1 = await session.prove(maxExpr, maxSpec)
  const r2 = await session.prove(wrongExpr, maxSpec)
  const r3 = await session.prove(maxExpr, maxSpec)
  ok('session proves correct max (unbounded)', r1.proven === true)
  ok('session refutes wrong candidate with a counterexample',
    r2.proven === false && 'counterexample' in r2)
  ok('session stays correct after a push/pop cycle', r3.proven === true)

  // ---- 2. parallel proving: many obligations, separate sessions ----
  const N = 12
  const jobs = Array.from({ length: N }, (_, i) => i)
  const proveOne = async (i: number): Promise<boolean> => {
    // each job gets its own session (independent solver) so they overlap
    const s = openSmtSession({ z3, arity: 2 })
    const expr: Expr = i % 2 === 0 ? maxExpr : wrongExpr
    const verdict = await s.prove(expr, maxSpec)
    return verdict.proven === true
  }

  const t0 = performance.now()
  const serial: boolean[] = []
  for (const i of jobs) serial.push(await proveOne(i))
  const serialMs = performance.now() - t0

  const t1 = performance.now()
  const concurrent = await mapConcurrent(jobs, proveOne, 8)
  const concurrentMs = performance.now() - t1

  // even jobs (max) prove, odd jobs (wrong) do not
  const expected = jobs.map(i => i % 2 === 0)
  ok('parallel results are correct and in order',
    JSON.stringify(concurrent) === JSON.stringify(expected))
  ok('serial and parallel agree', JSON.stringify(serial) === JSON.stringify(concurrent))
  console.log(`  serial ${serialMs.toFixed(0)}ms vs concurrent ${concurrentMs.toFixed(0)}ms over ${N} obligations`)

  console.log(`\nseed-verify perf demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
