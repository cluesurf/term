/**
 * IC3 / PDR: unbounded safety by inductive-invariant discovery. Run:
 *   npx tsx deck/test/code/demo-ic3.ts
 *
 * IC3 proves (or refutes) safety for ALL time, like k-induction, but
 * without needing the property to already be inductive - it discovers
 * the strengthening itself. We run it on the same systems as the BMC
 * demo and cross-check: IC3's verdict must agree with BMC (bounded) and
 * k-induction, and on the buggy systems it must produce a real
 * counterexample trace.
 *
 * Needs z3-solver.
 */

import { ic3 } from './ic3'
import { bmc, kInduction, type System } from './bmc'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try { z3 = await makeSmt() } catch {
    console.log('\nseed-verify ic3 demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // wrapping counter: safe for all time (invariant 0<=x<=3)
  const safeCounter: System = {
    vars: ['x'],
    init: s => s.x.eq(0),
    trans: (s, sn) => sn.x.eq(z3.If(s.x.lt(3), s.x.add(1), z3.Int.val(0))),
    safe: s => z3.And(s.x.ge(0), s.x.le(3)),
  }
  const counterResult = await ic3(safeCounter, z3)
  ok('IC3 PROVES the wrapping counter safe for all time', counterResult.safe === true,
    counterResult.safe ? `(converged at frame ${counterResult.invariantFrames})` : '')
  ok('IC3 agrees with k-induction on the counter',
    counterResult.safe === (await kInduction(safeCounter, 1, z3)).proven)

  // buggy counter: increments unbounded; safe says x<=3 -> UNSAFE
  const buggyCounter: System = {
    vars: ['x'],
    init: s => s.x.eq(0),
    trans: (s, sn) => z3.Or(sn.x.eq(s.x.add(1)), sn.x.eq(s.x)),
    safe: s => s.x.le(3),
  }
  const buggyResult = await ic3(buggyCounter, z3)
  ok('IC3 refutes the unbounded counter (UNSAFE)', buggyResult.safe === false)
  ok('IC3 returns a counterexample trace',
    buggyResult.safe === false && 'trace' in buggyResult,
    buggyResult.safe === false && 'trace' in buggyResult
      ? `x: ${buggyResult.trace.map(r => r.x).join(' -> ')}` : '')

  // lock-guarded mutex: mutual exclusion holds for all time
  const correctMutex: System = {
    vars: ['pc1', 'pc2', 'lock'],
    init: s => z3.And(s.pc1.eq(0), s.pc2.eq(0), s.lock.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.pc1.eq(0), s.lock.eq(0), sn.pc1.eq(1), sn.lock.eq(1), sn.pc2.eq(s.pc2)),
      z3.And(s.pc1.eq(1), sn.pc1.eq(0), sn.lock.eq(0), sn.pc2.eq(s.pc2)),
      z3.And(s.pc2.eq(0), s.lock.eq(0), sn.pc2.eq(1), sn.lock.eq(1), sn.pc1.eq(s.pc1)),
      z3.And(s.pc2.eq(1), sn.pc2.eq(0), sn.lock.eq(0), sn.pc1.eq(s.pc1)),
    ),
    safe: s => z3.Not(z3.And(s.pc1.eq(1), s.pc2.eq(1))),
  }
  const mutexResult = await ic3(correctMutex, z3)
  ok('IC3 PROVES the lock-guarded mutex safe for all time', mutexResult.safe === true,
    mutexResult.safe ? `(converged at frame ${mutexResult.invariantFrames})` : '')

  // buggy mutex: no lock guard -> both can enter -> UNSAFE
  const buggyMutex: System = {
    vars: ['pc1', 'pc2'],
    init: s => z3.And(s.pc1.eq(0), s.pc2.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.pc1.eq(0), sn.pc1.eq(1), sn.pc2.eq(s.pc2)),
      z3.And(s.pc1.eq(1), sn.pc1.eq(0), sn.pc2.eq(s.pc2)),
      z3.And(s.pc2.eq(0), sn.pc2.eq(1), sn.pc1.eq(s.pc1)),
      z3.And(s.pc2.eq(1), sn.pc2.eq(0), sn.pc1.eq(s.pc1)),
    ),
    safe: s => z3.Not(z3.And(s.pc1.eq(1), s.pc2.eq(1))),
  }
  const buggyMutexResult = await ic3(buggyMutex, z3)
  ok('IC3 refutes the unguarded mutex (UNSAFE)', buggyMutexResult.safe === false)

  console.log(`\nseed-verify ic3 demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
