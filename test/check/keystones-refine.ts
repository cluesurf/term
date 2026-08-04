// The Vibe Theory pinch-point keystones, discharged by the chosen stack's automated refinement prover
// (refine.ts, the Fourier-Motzkin linear decision procedure that backs `hold` clauses). The pinch-point is the
// meeting of two pressures on the dimension, and that meeting is pure linear arithmetic, exactly the prover's
// fragment. The floor's spinor-vs-vector crossing and the ceiling's dimension bound are checked as concrete
// linear facts. Run: npx tsx test/check/keystones-refine.ts

import {
  linear,
  atMost,
  atLeast,
  below,
  above,
  proves,
} from '@term/make/code/check/refine'

const lit = (n: number) => linear({}, n)
const d = linear({ dimension: 1 }) // the dimension, a free variable

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

// ===== the one-substance floor =====
// vector size is n; the half-spinor size is 2^(n/2 - 1). They cross exactly at eight: below eight the spinor is
// smaller, at eight they are equal, above eight the spinor is larger. So eight is the unique dimension where the
// directions you move (the vector) and the matter that moves (the spinor) are the same size. The half-spinor
// sizes are the concrete constants; the comparison is what the prover discharges.
expect(
  'floor: at dim 2, spinor 1 < vector 2',
  proves([], below(lit(1), lit(2))),
  true,
)
expect(
  'floor: at dim 4, spinor 2 < vector 4',
  proves([], below(lit(2), lit(4))),
  true,
)
expect(
  'floor: at dim 6, spinor 4 < vector 6',
  proves([], below(lit(4), lit(6))),
  true,
)
expect(
  'floor: at dim 8, spinor 8 = vector 8 (<=)',
  proves([], atMost(lit(8), lit(8))),
  true,
)
expect(
  'floor: at dim 8, spinor 8 = vector 8 (>=)',
  proves([], atLeast(lit(8), lit(8))),
  true,
)
expect(
  'floor: at dim 8, spinor is NOT below vector',
  proves([], below(lit(8), lit(8))),
  false,
)
expect(
  'floor: at dim 10, spinor 16 > vector 10',
  proves([], above(lit(16), lit(10))),
  true,
)

// ===== the reversibility ceiling =====
// the composition algebras run out at dimension eight; the next doubling, the sedenions at sixteen, is past the
// ceiling, where the norm dies. So the reversible dimension is at most eight, and sixteen exceeds it.
expect(
  'ceiling: the sedenion dimension 16 exceeds the ceiling 8',
  proves([], above(lit(16), lit(8))),
  true,
)
expect(
  'ceiling: eight is not above eight (it is the top rung)',
  proves([], above(lit(8), lit(8))),
  false,
)

// ===== the pinch-point: ceiling meets floor, the dimension is forced to eight =====
// from the ceiling (dimension <= 8) and the floor (dimension >= 8), the dimension is pinned to exactly eight: it
// is not below eight and not above eight. This is the keystone, and it is a linear deduction the prover closes.
const pinch = [atMost(d, lit(8)), atLeast(d, lit(8))]
expect(
  'pinch: ceiling and floor give dimension <= 8',
  proves(pinch, atMost(d, lit(8))),
  true,
)
expect(
  'pinch: ceiling and floor give dimension >= 8',
  proves(pinch, atLeast(d, lit(8))),
  true,
)
expect(
  'pinch: the dimension cannot be below 8',
  proves(pinch, below(d, lit(8))),
  false,
)
expect(
  'pinch: the dimension cannot be above 8',
  proves(pinch, above(d, lit(8))),
  false,
)
// so the dimension is exactly eight: forced, not chosen.

console.log(
  `\nkeystones (refinement prover): ${pass} pass, ${fail} fail`,
)
