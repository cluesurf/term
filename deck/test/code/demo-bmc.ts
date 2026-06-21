/**
 * Automated symbolic model checking via Z3. Run:
 *   npx tsx deck/test/code/demo-bmc.ts
 *
 *   A. a counter: BMC finds the exact step it overflows the bound (a
 *      counterexample TRACE); k-induction proves the wrapping version
 *      safe for ALL steps (unbounded).
 *   B. a mutex: BMC finds the bad INTERLEAVING where both processes
 *      enter the critical section (the killer feature of model
 *      checking); the lock-guarded version is safe within the bound.
 *
 * Symbolic: Z3 reasons over sets of states as formulas, not by
 * enumeration. Needs z3-solver.
 */

import { bmc, kInduction, type System } from './bmc'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try {
    z3 = await makeSmt()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify bmc demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // ===== A. counter =====
  console.log('--- A. counter ---')

  // buggy: increments without bound; safe says x <= 3
  const buggyCounter: System = {
    vars: ['x'],
    init: (s) => s.x.eq(0),
    trans: (s, sn) => z3.Or(sn.x.eq(s.x.add(1)), sn.x.eq(s.x)),
    safe: (s) => s.x.le(3),
  }
  const overflow = await bmc(buggyCounter, 6, z3)
  ok('BMC finds the counter overflow', !overflow.safe,
    !overflow.safe ? `trace x: ${overflow.trace.map(r => r.x).join(' -> ')}` : '')

  // safe: wraps at 3; the invariant 0<=x<=3 is inductive
  const safeCounter: System = {
    vars: ['x'],
    init: (s) => s.x.eq(0),
    trans: (s, sn) => sn.x.eq(z3.If(s.x.lt(3), s.x.add(1), z3.Int.val(0))),
    safe: (s) => z3.And(s.x.ge(0), s.x.le(3)),
  }
  ok('BMC: wrapping counter safe within 12 steps', (await bmc(safeCounter, 12, z3)).safe)
  ok('k-induction PROVES wrapping counter safe for ALL steps',
    (await kInduction(safeCounter, 1, z3)).proven)

  // ===== B. mutex =====
  console.log('\n--- B. mutual exclusion ---')

  // buggy: a process enters the critical section with no lock check
  const buggyMutex: System = {
    vars: ['pc1', 'pc2'],
    init: (s) => z3.And(s.pc1.eq(0), s.pc2.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.pc1.eq(0), sn.pc1.eq(1), sn.pc2.eq(s.pc2)),  // p1 enter (no guard - BUG)
      z3.And(s.pc1.eq(1), sn.pc1.eq(0), sn.pc2.eq(s.pc2)),  // p1 exit
      z3.And(s.pc2.eq(0), sn.pc2.eq(1), sn.pc1.eq(s.pc1)),  // p2 enter (no guard - BUG)
      z3.And(s.pc2.eq(1), sn.pc2.eq(0), sn.pc1.eq(s.pc1)),  // p2 exit
    ),
    safe: (s) => z3.Not(z3.And(s.pc1.eq(1), s.pc2.eq(1))),
  }
  const race = await bmc(buggyMutex, 4, z3)
  ok('BMC finds the bad interleaving (both in critical)', !race.safe,
    !race.safe ? `trace (pc1,pc2): ${race.trace.map(r => `(${r.pc1},${r.pc2})`).join(' -> ')}` : '')

  // correct: enter only when the lock is free, and take it
  const correctMutex: System = {
    vars: ['pc1', 'pc2', 'lock'],
    init: (s) => z3.And(s.pc1.eq(0), s.pc2.eq(0), s.lock.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.pc1.eq(0), s.lock.eq(0), sn.pc1.eq(1), sn.lock.eq(1), sn.pc2.eq(s.pc2)),
      z3.And(s.pc1.eq(1), sn.pc1.eq(0), sn.lock.eq(0), sn.pc2.eq(s.pc2)),
      z3.And(s.pc2.eq(0), s.lock.eq(0), sn.pc2.eq(1), sn.lock.eq(1), sn.pc1.eq(s.pc1)),
      z3.And(s.pc2.eq(1), sn.pc2.eq(0), sn.lock.eq(0), sn.pc1.eq(s.pc1)),
    ),
    safe: (s) => z3.Not(z3.And(s.pc1.eq(1), s.pc2.eq(1))),
  }
  ok('BMC: lock-guarded mutex safe within 12 steps', (await bmc(correctMutex, 12, z3)).safe)

  console.log(`\nseed-verify bmc demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
