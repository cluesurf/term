// Multivariate real arithmetic by cylindrical algebraic decomposition (CAD): the BIVARIATE non-negativity decision
// `p(x, y) >= 0 for all real x, y`. It projects onto the x-axis (the y-discriminant and the y-coefficient polynomials),
// cell-decomposes the line by the one-dimensional CAD, and decides the univariate-in-y condition at one rational sample
// per cell. The showcase is the MOTZKIN polynomial `x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1`: the classic form that is
// non-negative everywhere yet provably NOT a sum of squares, so no SOS certificate exists -- CAD proves it regardless.
// Soundness controls: every polynomial that genuinely dips below zero is rejected. Run: npx tsx test/check/cad-multivariate.ts

import { bivariateNonNegative } from '@cluesurf/make/code/check/cad'
import type { Bivariate } from '@cluesurf/make/code/check/cad'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

// build a bivariate from a list of `[i, j, coeff]` terms (coeff of x^i y^j)
function biv(terms: [number, number, bigint][]): Bivariate {
  let maxI = 0
  let maxJ = 0

  for (const [i, j] of terms) {
    maxI = Math.max(maxI, i)
    maxJ = Math.max(maxJ, j)
  }

  const out: Bivariate = []

  for (let i = 0; i <= maxI; i++) {
    out.push(new Array(maxJ + 1).fill(0n))
  }

  for (const [i, j, c] of terms) {
    out[i]![j] = c
  }

  return out
}

// 1. x^2 + y^2 >= 0 everywhere (a sum of squares -- the easy case, but still bivariate).
ok(
  'x^2 + y^2 >= 0 for all x, y',
  bivariateNonNegative(biv([[2, 0, 1n], [0, 2, 1n]])),
)

// 2. (x - y)^2 = x^2 - 2xy + y^2 >= 0 everywhere (touches zero along the line x = y).
ok(
  '(x - y)^2 >= 0 for all x, y (touches zero on a line)',
  bivariateNonNegative(biv([[2, 0, 1n], [1, 1, -2n], [0, 2, 1n]])),
)

// 3. SOUNDNESS: x^2 + y^2 - 1 is NEGATIVE inside the unit disc, so NOT >= 0 everywhere.
ok(
  'soundness: x^2 + y^2 - 1 is rejected (negative near origin)',
  !bivariateNonNegative(biv([[2, 0, 1n], [0, 2, 1n], [0, 0, -1n]])),
)

// 4. SOUNDNESS: x^2 - y^2 takes both signs (negative when |y| > |x|), so NOT >= 0 everywhere.
ok(
  'soundness: x^2 - y^2 is rejected (saddle)',
  !bivariateNonNegative(biv([[2, 0, 1n], [0, 2, -1n]])),
)

// 5. SOUNDNESS: y^2 - x is negative for x > 0 (e.g. x = 1, y = 0), so NOT >= 0 everywhere.
ok(
  'soundness: y^2 - x is rejected (negative for x > 0)',
  !bivariateNonNegative(biv([[0, 2, 1n], [1, 0, -1n]])),
)

// 6. THE MOTZKIN POLYNOMIAL: x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0 everywhere (by AM-GM) yet NOT a sum of squares. CAD
// proves it where no SOS certificate can exist.
ok(
  'MOTZKIN x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0 (non-negative, not a sum of squares)',
  bivariateNonNegative(
    biv([[4, 2, 1n], [2, 4, 1n], [2, 2, -3n], [0, 0, 1n]]),
  ),
)

// 7. SOUNDNESS near Motzkin: drop the constant to make x^4 y^2 + x^2 y^4 - 3 x^2 y^2, which is NEGATIVE (it equals
// x^2 y^2 (x^2 + y^2 - 3), below zero when x^2 + y^2 < 3 with x, y != 0, e.g. x = y = 1 gives 1 + 1 - 3 = -1).
ok(
  'soundness: x^4 y^2 + x^2 y^4 - 3 x^2 y^2 is rejected (Motzkin minus its constant)',
  !bivariateNonNegative(biv([[4, 2, 1n], [2, 4, 1n], [2, 2, -3n]])),
)

// 8. 1 + x^2 y^2 >= 0 everywhere (a sum of squares).
ok(
  '1 + x^2 y^2 >= 0 for all x, y',
  bivariateNonNegative(biv([[0, 0, 1n], [2, 2, 1n]])),
)

// 9. SOUNDNESS: 2xy takes both signs, so NOT >= 0 everywhere.
ok(
  'soundness: 2xy is rejected (opposite signs)',
  !bivariateNonNegative(biv([[1, 1, 2n]])),
)

// 10. SOUNDNESS: an ODD y-degree fibre, y^3, runs to -infinity, so NOT >= 0 everywhere.
ok(
  'soundness: y^3 is rejected (odd degree runs negative)',
  !bivariateNonNegative(biv([[0, 3, 1n]])),
)

// 11. a perfect bivariate square (x^2 - y)^2 = x^4 - 2 x^2 y + y^2 >= 0 everywhere (touches zero on the parabola
// y = x^2). The discriminant projection handles the parabola of tangency.
ok(
  '(x^2 - y)^2 >= 0 for all x, y (touches zero on a parabola)',
  bivariateNonNegative(biv([[4, 0, 1n], [2, 1, -2n], [0, 2, 1n]])),
)

// 12. SOUNDNESS: x^2 - y (one branch of the above before squaring) is negative for y > x^2, so NOT >= 0 everywhere.
ok(
  'soundness: x^2 - y is rejected (negative above the parabola)',
  !bivariateNonNegative(biv([[2, 0, 1n], [0, 1, -1n]])),
)

console.log(`\ncad-multivariate: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
