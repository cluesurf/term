// n-variable cylindrical algebraic decomposition: the non-negativity decision `p(x_0, ..., x_{k-1}) >= 0 for all reals`
// in any number of variables, by the recursive CAD (Collins projection + all-rational open-cell sampling). The
// trivariate showcase is the CHOI-LAM form `x^4 y^2 + y^4 z^2 + z^4 x^2 - 3 x^2 y^2 z^2`: non-negative by AM-GM yet NOT
// a sum of squares, so it has no SOS certificate -- CAD proves it. Soundness controls: every polynomial that genuinely
// dips below zero is rejected. Run: npx tsx test/check/cad-nvar.ts

import {
  nonNegativeEverywhereNvar,
  nPoly,
} from '@cluesurf/make/code/check/cad-nvar'

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

// ===== one variable (regression of the base case through the general engine) =====

// x^2 + 1 > 0, and x^4 - 3x^2 + 3 >= 0 (no real root); x^2 - 1 dips negative.
ok('1-var: x^2 + 1 >= 0', nonNegativeEverywhereNvar(nPoly([[[2], 1n], [[0], 1n]]), 1))
ok(
  '1-var: x^4 - 3x^2 + 3 >= 0',
  nonNegativeEverywhereNvar(nPoly([[[4], 1n], [[2], -3n], [[0], 3n]]), 1),
)
ok(
  '1-var soundness: x^2 - 1 is rejected',
  !nonNegativeEverywhereNvar(nPoly([[[2], 1n], [[0], -1n]]), 1),
)

// ===== two variables (regression: Motzkin through the general engine) =====

// x^2 + y^2 >= 0
ok(
  '2-var: x^2 + y^2 >= 0',
  nonNegativeEverywhereNvar(nPoly([[[2, 0], 1n], [[0, 2], 1n]]), 2),
)

// the MOTZKIN polynomial x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0 (non-negative, not a sum of squares)
ok(
  '2-var MOTZKIN: x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0',
  nonNegativeEverywhereNvar(
    nPoly([[[4, 2], 1n], [[2, 4], 1n], [[2, 2], -3n], [[0, 0], 1n]]),
    2,
  ),
)

// soundness: Motzkin minus its constant dips negative
ok(
  '2-var soundness: Motzkin minus its constant is rejected',
  !nonNegativeEverywhereNvar(
    nPoly([[[4, 2], 1n], [[2, 4], 1n], [[2, 2], -3n]]),
    2,
  ),
)

// soundness: x^2 - y^2 is a saddle
ok(
  '2-var soundness: x^2 - y^2 is rejected (saddle)',
  !nonNegativeEverywhereNvar(nPoly([[[2, 0], 1n], [[0, 2], -1n]]), 2),
)

// ===== three variables =====

// the simplest: x^2 + y^2 + z^2 >= 0
ok(
  '3-var: x^2 + y^2 + z^2 >= 0',
  nonNegativeEverywhereNvar(
    nPoly([[[2, 0, 0], 1n], [[0, 2, 0], 1n], [[0, 0, 2], 1n]]),
    3,
  ),
)

// THE CHOI-LAM FORM: x^4 y^2 + y^4 z^2 + z^4 x^2 - 3 x^2 y^2 z^2 >= 0. Non-negative by AM-GM (the three quartic-quadratic
// terms have geometric mean x^2 y^2 z^2), yet provably NOT a sum of squares. CAD proves it; no SOS certificate exists.
const choiLam: [number[], bigint][] = [
  [[4, 2, 0], 1n],
  [[0, 4, 2], 1n],
  [[2, 0, 4], 1n],
  [[2, 2, 2], -3n],
]
ok(
  '3-var CHOI-LAM: x^4 y^2 + y^4 z^2 + z^4 x^2 - 3 x^2 y^2 z^2 >= 0 (not a sum of squares)',
  nonNegativeEverywhereNvar(nPoly(choiLam), 3),
)

// SOUNDNESS near Choi-Lam: raise the subtracted coefficient past the AM-GM bound -- x^4 y^2 + y^4 z^2 + z^4 x^2 -
// 4 x^2 y^2 z^2 is NEGATIVE at x = y = z = 1 (3 - 4 = -1). It must be rejected.
ok(
  '3-var soundness: ...-4 x^2 y^2 z^2 is rejected (below the AM-GM bound)',
  !nonNegativeEverywhereNvar(
    nPoly([[[4, 2, 0], 1n], [[0, 4, 2], 1n], [[2, 0, 4], 1n], [[2, 2, 2], -4n]]),
    3,
  ),
)

// SOUNDNESS: a trivariate saddle x^2 + y^2 - z^2 dips negative (z large), rejected.
ok(
  '3-var soundness: x^2 + y^2 - z^2 is rejected',
  !nonNegativeEverywhereNvar(
    nPoly([[[2, 0, 0], 1n], [[0, 2, 0], 1n], [[0, 0, 2], -1n]]),
    3,
  ),
)

// a trivariate perfect square (x y - z)^2 = x^2 y^2 - 2 x y z + z^2 >= 0 (touches zero on the surface z = x y).
ok(
  '3-var: (xy - z)^2 >= 0 (touches zero on a surface)',
  nonNegativeEverywhereNvar(
    nPoly([[[2, 2, 0], 1n], [[1, 1, 1], -2n], [[0, 0, 2], 1n]]),
    3,
  ),
)

// SOUNDNESS: x y - z (one branch before squaring) takes both signs, rejected.
ok(
  '3-var soundness: xy - z is rejected (both signs)',
  !nonNegativeEverywhereNvar(nPoly([[[1, 1, 0], 1n], [[0, 0, 1], -1n]]), 3),
)

console.log(`\ncad-nvar: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
