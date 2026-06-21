/**
 * LTL model checking via bounded model checking with lasso detection.
 * Run:
 *   npx tsx deck/test/code/demo-ltl.ts
 *
 * Safety (G p) and liveness (F p, G F p) over a transition system, with
 * counterexamples: a safety violation is a finite prefix, a liveness
 * violation is a LASSO (a loop on which the good thing never happens). We
 * cross-check safety against BMC (G p holds iff BMC finds no unsafe state
 * with safe = p).
 *
 * Needs z3-solver.
 */

import { ltlCheck, atom, globally, eventually } from './ltl'
import { bmc, type System } from './bmc'
import { makeSmt } from './smt'

async function main(): Promise<void> {
  let z3
  try { z3 = await makeSmt() } catch {
    console.log('\nseed-verify ltl demo: skipped (no z3)')
    return
  }

  let pass = 0
  let fail = 0
  function ok(name: string, cond: boolean, info = ''): void {
    if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
    else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
  }

  // a wrapping counter: 0 -> 1 -> 2 -> 3 -> 0 -> ... (deterministic cycle)
  const counter: System = {
    vars: ['x'],
    init: s => s.x.eq(0),
    trans: (s, sn) => sn.x.eq(z3.If(s.x.lt(3), s.x.add(1), z3.Int.val(0))),
    safe: s => s.x.le(3),
  }
  const leq3 = atom((s: any) => s.x.le(3))
  const eq3 = atom((s: any) => s.x.eq(3))
  const eq0 = atom((s: any) => s.x.eq(0))
  const eq5 = atom((s: any) => s.x.eq(5))

  // G (x <= 3): safety, holds
  const gSafe = await ltlCheck({ system: counter, property: globally(leq3), k: 6, z3 })
  ok('G(x<=3) holds (safety)', gSafe.holds === true)
  // cross-check against BMC (safe = x<=3)
  ok('LTL G agrees with BMC safety', gSafe.holds === (await bmc(counter, 6, z3)).safe)

  // F (x == 3): liveness, holds (the cycle always reaches 3)
  const fReach = await ltlCheck({ system: counter, property: eventually(eq3), k: 6, z3 })
  ok('F(x==3) holds (liveness, reached on the cycle)', fReach.holds === true)

  // G F (x == 0): x is 0 infinitely often, holds
  const gf = await ltlCheck({ system: counter, property: globally(eventually(eq0)), k: 6, z3 })
  ok('G F(x==0) holds (infinitely often)', gf.holds === true)

  // F (x == 5): x never reaches 5 (wraps at 3) -> FALSE, counterexample is a lasso
  const fBad = await ltlCheck({ system: counter, property: eventually(eq5), k: 6, z3 })
  ok('F(x==5) is refuted with a LASSO counterexample',
    fBad.holds === false && fBad.loopStart >= 0,
    fBad.holds === false ? `loop@${fBad.loopStart}, x: ${fBad.trace.map(r => r.x).join('->')}` : '')

  // a buggy unbounded counter: G(x<=3) FAILS with a finite safety prefix
  const buggy: System = {
    vars: ['x'],
    init: s => s.x.eq(0),
    trans: (s, sn) => z3.Or(sn.x.eq(s.x.add(1)), sn.x.eq(s.x)),
    safe: s => s.x.le(3),
  }
  const gFail = await ltlCheck({ system: buggy, property: globally(leq3), k: 6, z3 })
  ok('G(x<=3) refuted on the unbounded counter', gFail.holds === false)
  ok('LTL G-failure agrees with BMC', gFail.holds === (await bmc(buggy, 6, z3)).safe)

  console.log(`\nseed-verify ltl demo: ${pass} pass, ${fail} fail`)
  if (fail > 0) process.exit(1)
}

main()
