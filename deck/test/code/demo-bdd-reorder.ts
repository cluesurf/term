/**
 * BDD variable reordering (sifting) - the performance lever. Run:
 *   npx tsx deck/test/code/demo-bdd-reorder.ts
 *
 * The textbook witness: the equality function f = AND_i (a_i <-> b_i).
 * Under the SEPARATED order (all a's, then all b's) its BDD is
 * exponential in n; under the INTERLEAVED order (a0,b0,a1,b1,...) it is
 * linear. We build it under the bad order, then let `siftReorder` find a
 * good one, and watch the node count collapse - same function, a
 * fraction of the size.
 */

import { BddManager, siftReorder, type Bdd } from './bdd'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const N = 6
const a = (i: number) => 2 * i // a_i variables
const b = (i: number) => 2 * i + 1 // b_i variables

// the SEPARATED (bad) order: a0 a1 ... a5  b0 b1 ... b5
const separated: number[] = [
  ...Array.from({ length: N }, (_, i) => a(i)),
  ...Array.from({ length: N }, (_, i) => b(i)),
]

const mgr = new BddManager(separated)

// f = AND_i not(a_i xor b_i)  =  AND_i (a_i <-> b_i)
let f: Bdd = mgr.TRUE
for (let i = 0; i < N; i++) {
  const eq = mgr.not(mgr.xor(mgr.variable(a(i)), mgr.variable(b(i))))
  f = mgr.and(f, eq)
}

const before = mgr.reachable([f])
console.log(`  separated order: ${before} nodes`)

const reordered = siftReorder(mgr, [f])
console.log(`  after sifting:   ${reordered.after} nodes  (order ${reordered.order.join(',')})`)

// the equality function under a good order is linear: ~3n nodes, far below the bad-order count
ok('sifting strictly shrinks the BDD', reordered.after < before,
  `${before} -> ${reordered.after}`)
ok('sifting reaches the linear size (<= 3N+2)', reordered.after <= 3 * N + 2,
  `${reordered.after} <= ${3 * N + 2}`)

// the reordered BDD must be the SAME function: spot-check a few assignments
function evalBdd(m: BddManager, root: Bdd, assign: Record<number, boolean>): boolean {
  let cur = root
  while (cur > 1) {
    // restrict each variable in turn until we hit a terminal
    let advanced = false
    for (const [vStr, val] of Object.entries(assign)) {
      const v = Number(vStr)
      const next = m.restrict(cur, v, val)
      if (next !== cur) { cur = next; advanced = true }
    }
    if (!advanced) break
  }
  return cur === 1
}

const allEqual: Record<number, boolean> = {}
for (let i = 0; i < N; i++) { allEqual[a(i)] = true; allEqual[b(i)] = true }
const oneOff: Record<number, boolean> = { ...allEqual, [b(0)]: false }

ok('reordered function agrees on all-equal (true)',
  evalBdd(reordered.manager, reordered.roots[0]!, allEqual) === true)
ok('reordered function agrees on a mismatch (false)',
  evalBdd(reordered.manager, reordered.roots[0]!, oneOff) === false)

console.log(`\nseed-verify bdd-reorder demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
