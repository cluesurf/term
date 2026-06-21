/**
 * Deductive verification of imperative algorithms (Dafny/Why3-style).
 * Run from the seed install root:
 *   npx tsx deck/test/code/demo-deductive.ts
 *
 * Each procedure carries a contract (requires/ensures) and, for loops,
 * an invariant and a variant. The engine computes verification
 * conditions by weakest precondition and discharges them with Z3. A
 * correct procedure verifies for ALL inputs and is proven to terminate;
 * a wrong postcondition, a non-inductive invariant, or a non-decreasing
 * variant is REJECTED (the soundness controls).
 *
 * Needs z3-solver.
 */

import {
  verifyProcedure,
  v, lit, add, sub,
  tt, le, lt, eq, ge, and, not,
  assign, seq, ifThenElse, whileLoop,
  type Procedure,
} from './deductive'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try { z3 = await makeSmt() } catch {
    console.log('\nseed-verify deductive demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // --- 1. count up to n: i:=0; while i<n inv 0<=i<=n variant n-i do i:=i+1; ensures i==n ---
  const countUp: Procedure = {
    name: 'count-up',
    vars: ['i', 'n'],
    requires: ge(v('n'), lit(0)),
    ensures: eq(v('i'), v('n')),
    body: seq(
      assign('i', lit(0)),
      whileLoop({
        cond: lt(v('i'), v('n')),
        invariant: and(ge(v('i'), lit(0)), le(v('i'), v('n'))),
        variant: sub(v('n'), v('i')),
        body: assign('i', add(v('i'), lit(1))),
      }),
    ),
  }
  const r1 = await verifyProcedure(countUp, z3)
  ok('count-up verifies (correct + terminating)', r1.verified === true,
    r1.verified ? `(${r1.conditions} VCs discharged)` : '')

  // --- 2. running counter s tracks i: s==i invariant; ensures s==n ---
  const counter: Procedure = {
    name: 'counter',
    vars: ['s', 'i', 'n'],
    requires: ge(v('n'), lit(0)),
    ensures: eq(v('s'), v('n')),
    body: seq(
      assign('s', lit(0)),
      assign('i', lit(0)),
      whileLoop({
        cond: lt(v('i'), v('n')),
        invariant: and(eq(v('s'), v('i')), le(v('i'), v('n'))),
        variant: sub(v('n'), v('i')),
        body: seq(assign('s', add(v('s'), lit(1))), assign('i', add(v('i'), lit(1)))),
      }),
    ),
  }
  ok('counter verifies (loop invariant s==i carries the post)',
    (await verifyProcedure(counter, z3)).verified === true)

  // --- 3. abs via if (no loop): ensures r>=0 and (r==x or r==-x) ---
  const absVal: Procedure = {
    name: 'abs',
    vars: ['x', 'r'],
    requires: tt,
    ensures: and(ge(v('r'), lit(0)), { form: 'or', left: eq(v('r'), v('x')), right: eq(v('r'), sub(lit(0), v('x'))) }),
    body: ifThenElse(lt(v('x'), lit(0)), assign('r', sub(lit(0), v('x'))), assign('r', v('x'))),
  }
  ok('abs verifies (branch reasoning)', (await verifyProcedure(absVal, z3)).verified === true)

  // --- 4. SOUNDNESS: a wrong postcondition is REJECTED ---
  const wrongPost: Procedure = {
    ...countUp,
    name: 'count-up-wrong',
    ensures: eq(v('i'), add(v('n'), lit(1))), // claims i == n+1 (false)
  }
  const r4 = await verifyProcedure(wrongPost, z3)
  ok('wrong postcondition is rejected', r4.verified === false)

  // --- 5. SOUNDNESS: a non-decreasing variant is REJECTED (no termination proof) ---
  const badVariant: Procedure = {
    ...countUp,
    name: 'count-up-bad-variant',
    body: seq(
      assign('i', lit(0)),
      whileLoop({
        cond: lt(v('i'), v('n')),
        invariant: and(ge(v('i'), lit(0)), le(v('i'), v('n'))),
        variant: lit(5), // constant: does not decrease -> termination unprovable
        body: assign('i', add(v('i'), lit(1))),
      }),
    ),
  }
  ok('non-decreasing variant is rejected (termination unproven)',
    (await verifyProcedure(badVariant, z3)).verified === false)

  // --- 6. SOUNDNESS: a non-inductive invariant is REJECTED ---
  const badInvariant: Procedure = {
    ...countUp,
    name: 'count-up-bad-invariant',
    body: seq(
      assign('i', lit(0)),
      whileLoop({
        cond: lt(v('i'), v('n')),
        invariant: eq(v('i'), lit(0)), // not preserved by i:=i+1
        variant: sub(v('n'), v('i')),
        body: assign('i', add(v('i'), lit(1))),
      }),
    ),
  }
  ok('non-inductive invariant is rejected',
    (await verifyProcedure(badInvariant, z3)).verified === false)

  console.log(`\nseed-verify deductive demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
