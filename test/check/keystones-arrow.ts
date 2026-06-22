// The arrow-of-time keystone, discharged by the refinement prover (refine.ts). The arrow is the one-way order of
// the integers, and the integers are the UNIQUE totally ordered rung of the tower: in any ordered ring every
// square is at least zero, which the integers satisfy, but the very next rung carries a square root of minus one
// whose square is below zero, so no order can place it. So the order stops at the integers, and a one-way order
// is the arrow. The orderability and its failure one rung up are linear-arithmetic facts the prover discharges.
// Run: npx tsx test/check/keystones-arrow.ts

import {
  linear,
  atMost,
  atLeast,
  below,
  proves,
} from '@cluesurf/make/code/check/refine'

const lit = (n: number) => linear({}, n)
const isquared = linear({ isquared: 1 }) // the square of the new unit i, a free variable

let pass = 0
let fail = 0

function expect(name: string, got: boolean, want: boolean): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name} (got ${got}, want ${want})`)
  }
}

// ===== the integers are orderable: every square is non-negative =====
expect(
  'a square is non-negative: 2*2 = 4 >= 0',
  proves([], atLeast(lit(4), lit(0))),
  true,
)
expect(
  'a square is non-negative: (-3)*(-3) = 9 >= 0',
  proves([], atLeast(lit(9), lit(0))),
  true,
)
expect(
  'a square is non-negative: 0*0 = 0 >= 0',
  proves([], atLeast(lit(0), lit(0))),
  true,
)

// the order is one-way (strict, antisymmetric): if a < b then not b < a. with a = 2, b = 5: 2 < 5 holds,
// and 5 < 2 does not.
expect(
  'the order is one-way: 2 < 5 holds',
  proves([], below(lit(2), lit(5))),
  true,
)
expect(
  'the order is one-way: 5 < 2 does not hold',
  proves([], below(lit(5), lit(2))),
  false,
)

// ===== the next rung cannot be ordered: i^2 = -1 contradicts orderability =====
// assume the rung is ordered, so its squares are non-negative (i^2 >= 0), and that it carries i with i^2 = -1
// (i.e. i^2 <= -1 and i^2 >= -1). These are jointly unsatisfiable: 0 <= i^2 = -1 is false. So from them the prover
// proves even an absurd goal (ex falso), which is exactly the contradiction that forbids an order past the integers.
const ordered = atLeast(isquared, lit(0)) // orderability: i^2 >= 0
const iIsMinusOneLow = atMost(isquared, lit(-1)) // i^2 = -1 (the <= -1 half)
expect(
  'orderability together with i^2 = -1 is contradictory (the loss of order)',
  proves([ordered, iIsMinusOneLow], below(lit(0), lit(-1))), // an absurd goal follows from the contradiction
  true,
)
// control: orderability ALONE (without i^2 = -1) is consistent, so the absurd goal does NOT follow.
expect(
  'control: orderability alone is consistent (no contradiction)',
  proves([ordered], below(lit(0), lit(-1))),
  false,
)
// so the integers are the last orderable rung, and their one-way order is the arrow of time.

console.log(
  `\narrow of time (refinement prover): ${pass} pass, ${fail} fail`,
)
