/**
 * BDD-based symbolic model checking. Run:
 *   npx tsx deck/test/code/demo-bdd.ts
 *
 *   A. the BDD package itself (canonicity, the operators).
 *   B. symbolic reachability over a BDD-encoded transition system: a
 *      2-bit counter. When it wraps to 11, "never 11" is violated
 *      (11 reachable); when it saturates at 10, 11 is unreachable (safe).
 *
 * No Z3 here - this is the symbolic engine (BDDs) from scratch.
 * Deterministic.
 */

import { BddManager } from './bdd'
import { SymbolicChecker, type SymSystem } from './symbolic'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// ===== A. the BDD package =====
console.log('--- A. BDD package ---')
const m = new BddManager()
const a = m.variable(0)
const b = m.variable(1)

ok('canonicity: a&b === a&b (pointer equal)', m.and(a, b) === m.and(a, b))
ok('a | !a === TRUE', m.or(a, m.not(a)) === m.TRUE)
ok('a & !a === FALSE', m.and(a, m.not(a)) === m.FALSE)
ok('de Morgan: !(a&b) === !a | !b', m.not(m.and(a, b)) === m.or(m.not(a), m.not(b)))
ok('exists b. (a & b) === a', m.exists(m.and(a, b), 1) === a)
ok('restrict (a&b)[a=1] === b', m.restrict(m.and(a, b), 0, true) === b)

// ===== B. symbolic reachability =====
console.log('\n--- B. symbolic model checking (BDD reachability) ---')
// state = 2 bits (v1 hi, v0 lo); current vars 0,1; next vars 2,3.
const v1 = m.variable(0), v0 = m.variable(1)
const n1 = m.variable(2), n0 = m.variable(3)
const lit = (x: number, on: boolean) => (on ? m.variable(x) : m.not(m.variable(x)))
// a state pattern over current vars (hi, lo) and the matching next pattern
const cur = (hi: boolean, lo: boolean) => m.and(lit(0, hi), lit(1, lo))
const nxt = (hi: boolean, lo: boolean) => m.and(lit(2, hi), lit(3, lo))
const move = (h: boolean, l: boolean, h2: boolean, l2: boolean) => m.and(cur(h, l), nxt(h2, l2))

const checker = new SymbolicChecker(m, 2)

// wrapping counter: 00->01->10->11->00. bad = 11. 11 IS reachable.
const wrapping: SymSystem = {
  bits: 2,
  init: cur(false, false), // 00
  trans: m.or(
    move(false, false, false, true), // 00 -> 01
    m.or(
      move(false, true, true, false), // 01 -> 10
      m.or(
        move(true, false, true, true), // 10 -> 11
        move(true, true, false, false), // 11 -> 00
      ),
    ),
  ),
  bad: cur(true, true), // 11
}
ok('wrapping counter: bad state 11 IS reachable (unsafe)', !checker.check(wrapping).safe)

// saturating counter: 00->01->10->10 (stuck at 10). 11 unreachable.
const saturating: SymSystem = {
  bits: 2,
  init: cur(false, false),
  trans: m.or(
    move(false, false, false, true), // 00 -> 01
    m.or(
      move(false, true, true, false), // 01 -> 10
      move(true, false, true, false), // 10 -> 10 (stuck)
    ),
  ),
  bad: cur(true, true), // 11
}
ok('saturating counter: 11 is UNREACHABLE (safe)', checker.check(saturating).safe)

console.log(`\nseed-verify bdd demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
