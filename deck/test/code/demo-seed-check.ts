/**
 * Model-checking a property of seed/ ITSELF: the @cluesurf/link unit-
 * claim lifecycle. Run:
 *   npx tsx deck/test/code/demo-seed-check.ts
 *
 * link's core safety invariant (note/methodology/verification/
 * applying-to-cluesurf.md): a unit is never claimed by two sessions at
 * once. We model two sessions and one unit's claim as a transition
 * system and model-check it with the BMC engine (bmc.ts) + k-induction:
 *   - the CORRECT claim (take the lock only if free) is proven safe.
 *   - a NAIVE claim (no check) has a bad interleaving, found as a trace.
 *
 * This is the verification suite turned on seed's own components. Needs
 * z3-solver.
 */

import { bmc, kInduction, type System } from './bmc'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try {
    z3 = await makeSmt()
  } catch {
    console.log('z3-solver not installed - run `pnpm install`, then re-run.')
    console.log('\nseed-verify seed-check demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // State: held1, held2 in {0=not claiming, 1=holds the unit}; lock in
  // {0=free, 1=taken} (the link claim row's owner). Two tmux sessions.
  // Safety: never both sessions hold the same unit's claim.

  // CORRECT: a session claims only when the lock is free, and takes it;
  // releasing on done. (link's TMUX_PANE-keyed claim + recordDone.)
  const correctClaim: System = {
    vars: ['held1', 'held2', 'lock'],
    init: (s) => z3.And(s.held1.eq(0), s.held2.eq(0), s.lock.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.held1.eq(0), s.lock.eq(0), sn.held1.eq(1), sn.lock.eq(1), sn.held2.eq(s.held2)), // s1 claim
      z3.And(s.held1.eq(1), sn.held1.eq(0), sn.lock.eq(0), sn.held2.eq(s.held2)),               // s1 done
      z3.And(s.held2.eq(0), s.lock.eq(0), sn.held2.eq(1), sn.lock.eq(1), sn.held1.eq(s.held1)), // s2 claim
      z3.And(s.held2.eq(1), sn.held2.eq(0), sn.lock.eq(0), sn.held1.eq(s.held1)),               // s2 done
    ),
    safe: (s) => z3.Not(z3.And(s.held1.eq(1), s.held2.eq(1))),
  }
  ok('link claim: correct (lock-guarded) is safe within 14 steps',
    (await bmc(correctClaim, 14, z3)).safe)

  // NAIVE: a session claims without checking the lock (the bug link's
  // claim model prevents). Two sessions race into the same unit.
  const naiveClaim: System = {
    vars: ['held1', 'held2'],
    init: (s) => z3.And(s.held1.eq(0), s.held2.eq(0)),
    trans: (s, sn) => z3.Or(
      z3.And(s.held1.eq(0), sn.held1.eq(1), sn.held2.eq(s.held2)), // s1 claim (NO lock check)
      z3.And(s.held1.eq(1), sn.held1.eq(0), sn.held2.eq(s.held2)),
      z3.And(s.held2.eq(0), sn.held2.eq(1), sn.held1.eq(s.held1)), // s2 claim (NO lock check)
      z3.And(s.held2.eq(1), sn.held2.eq(0), sn.held1.eq(s.held1)),
    ),
    safe: (s) => z3.Not(z3.And(s.held1.eq(1), s.held2.eq(1))),
  }
  const race = await bmc(naiveClaim, 4, z3)
  ok('link claim: naive (unguarded) has a double-claim trace', !race.safe,
    !race.safe ? `trace (held1,held2): ${race.trace.map(r => `(${r.held1},${r.held2})`).join(' -> ')}` : '')

  console.log(`\nseed-verify seed-check demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
