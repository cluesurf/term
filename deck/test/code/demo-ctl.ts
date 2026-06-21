/**
 * CTL temporal-logic model checking (BDD fixpoints). Run:
 *   npx tsx deck/test/code/demo-ctl.ts
 *
 * Checks safety (AG) and liveness (AF, EG, EF) on small finite-state
 * systems. Shows the difference between a system that always makes
 * progress (AF goal holds) and one that can stall forever (EG !goal
 * holds, so AF goal fails). Deterministic, no Z3.
 */

import { BddManager } from './bdd'
import { CtlChecker } from './ctl'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const m = new BddManager()
const lit = (x: number, on: boolean) => (on ? m.variable(x) : m.not(m.variable(x)))
// 2-bit state: current vars 0 (hi), 1 (lo); next vars 2, 3.
const cur = (hi: boolean, lo: boolean) => m.and(lit(0, hi), lit(1, lo))
const move = (h: boolean, l: boolean, h2: boolean, l2: boolean) =>
  m.and(m.and(lit(0, h), lit(1, l)), m.and(lit(2, h2), lit(3, l2)))

// ===== A. wrapping counter: 00->01->10->11->00 =====
console.log('--- A. wrapping counter (always progresses) ---')
const wrapTrans = m.or(move(false, false, false, true),
  m.or(move(false, true, true, false),
    m.or(move(true, false, true, true), move(true, true, false, false))))
const wrap = new CtlChecker(m, 2, wrapTrans)
const init00 = cur(false, false)
const goal11 = cur(true, true)

ok('EF(11): 11 is reachable', wrap.holdsInitially(init00, wrap.ef(goal11)))
ok('AG(!11) is FALSE (11 reachable on some path)', !wrap.holdsInitially(init00, wrap.ag(m.not(goal11))))
ok('AF(11): every path eventually hits 11 (it cycles through)', wrap.holdsInitially(init00, wrap.af(goal11)))

// ===== B. stalling system: 00->01, 01->01 (stuck) =====
console.log('\n--- B. stalling system (can get stuck) ---')
const stallTrans = m.or(move(false, false, false, true), move(false, true, false, true))
const stall = new CtlChecker(m, 2, stallTrans)

ok('EF(01): 01 reachable', stall.holdsInitially(init00, stall.ef(cur(false, true))))
ok('AF(11) is FALSE: it stalls at 01, never reaching 11', !stall.holdsInitially(init00, stall.af(goal11)))
ok('EG(!11) is TRUE: a path avoids 11 forever', stall.holdsInitially(init00, stall.eg(m.not(goal11))))

console.log(`\nseed-verify ctl demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
