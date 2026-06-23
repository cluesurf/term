// Nonlinear real arithmetic -- the one-dimensional base case of cylindrical algebraic decomposition (CAD), decided by
// STURM'S THEOREM. A univariate real polynomial's sign pattern is fixed between consecutive roots, so counting the
// distinct real roots in an interval (the difference of the Sturm sequence's sign variations at the endpoints) decides
// every univariate sign condition: how many roots `p` has, whether `p` is a perfect square that touches zero, whether
// `p > 0` for all reals. This is exactly the kind of NONLINEAR fact the linear (Presburger) prover cannot reach --
// `x^2 + 1 > 0` is a sum-of-squares positivity, `x^2 - 2 = 0` an irrational-root existence -- and it is sound: a
// polynomial with a genuine real root is never reported positive-everywhere. Run: npx tsx test/check/cad.ts

import {
  realRootCount,
  rootCountIn,
  positiveEverywhere,
  nonNegativeEverywhere,
  positiveOnInterval,
  tarskiQuery,
  realRootsBySign,
  hasRealRoot,
  derivative,
} from '@cluesurf/make/code/check/sturm'

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

// coefficients are [c0, c1, c2, ...] = c0 + c1 x + c2 x^2 + ...

// 1. x^2 + 1 has NO real root and is positive everywhere (the canonical sum-of-squares positivity, beyond linear arith).
ok('x^2 + 1 has no real root', realRootCount([1, 0, 1]) === 0)
ok('x^2 + 1 > 0 for all real x', positiveEverywhere([1, 0, 1]))

// 2. SOUNDNESS: x^2 - 1 = (x-1)(x+1) has TWO real roots, so it is NOT positive everywhere.
ok('x^2 - 1 has two real roots', realRootCount([-1, 0, 1]) === 2)
ok('soundness: x^2 - 1 is not positive everywhere', !positiveEverywhere([-1, 0, 1]))

// 3. IRRATIONAL roots: x^2 - 2 has two real roots (+/- sqrt 2) -- Sturm counts them exactly without computing them.
ok('x^2 - 2 has two real roots (irrational)', realRootCount([-2, 0, 1]) === 2)
ok('x^2 - 2 has a real root', hasRealRoot([-2, 0, 1]))

// 4. a DOUBLE root: x^2 - 2x + 1 = (x-1)^2 has one DISTINCT real root, and is non-negative but not strictly positive.
ok('(x-1)^2 has one distinct real root', realRootCount([1, -2, 1]) === 1)
ok('soundness: (x-1)^2 is not > 0 everywhere (it touches 0)', !positiveEverywhere([1, -2, 1]))

// 5. a CUBIC always has at least one real root: x^3 - x = x(x-1)(x+1) has three.
ok('x^3 - x has three real roots', realRootCount([0, -1, 0, 1]) === 3)

// 6. ROOT LOCALIZATION: x^2 - x - 6 = (x-3)(x+2) has exactly one root in (0, 5] (namely 3) and one in (-5, 0].
ok('x^2 - x - 6 has one root in (0, 5]', rootCountIn([-6, -1, 1], 0, 5) === 1)
ok('x^2 - x - 6 has one root in (-5, 0]', rootCountIn([-6, -1, 1], -5, 0) === 1)

// 7. a QUARTIC with no real root stays positive: x^4 + 1 (sum of squares, not itself a single square).
ok('x^4 + 1 has no real root', realRootCount([1, 0, 0, 0, 1]) === 0)
ok('x^4 + 1 > 0 for all real x', positiveEverywhere([1, 0, 0, 0, 1]))

// 8. the MOTZKIN-style obstruction in one variable -- x^4 - 3x^2 + 3 has no real root (discriminant negative) and is
// positive everywhere, yet is NOT a single square. Sturm decides it regardless of the SOS certificate.
ok('x^4 - 3x^2 + 3 > 0 for all real x', positiveEverywhere([3, 0, -3, 0, 1]))

// 9. derivative sanity: d/dx (x^3 - x) = 3x^2 - 1.
const d = derivative([0, -1, 0, 1])
ok('derivative of x^3 - x is 3x^2 - 1', d.length === 3 && d[0] === -1 && d[1] === 0 && d[2] === 3)

// 10. SOUNDNESS at the boundary: a shallow well -- 10000 x^2 - 1 (roots at +/- 1/100) -- still has two real roots and is
// correctly NOT positive everywhere. Exact rational arithmetic is not fooled by a root close to zero.
ok('10000 x^2 - 1 has two real roots (shallow well)', realRootCount([-1, 0, 10000]) === 2)
ok('soundness: 10000 x^2 - 1 is not positive everywhere', !positiveEverywhere([-1, 0, 10000]))

// 11. COMPLETE non-negativity: a TOUCHING-zero polynomial (x-1)^2 (x-2)^2 = x^4 - 6x^3 + 13x^2 - 12x + 4 is >= 0
// everywhere (it touches zero at x = 1 and x = 2 but never goes negative). The cell decomposition accepts it even though
// it is NOT strictly positive -- the strict test correctly declines.
const touch = [4, -12, 13, -6, 1]
ok('(x-1)^2 (x-2)^2 >= 0 everywhere (touches zero)', nonNegativeEverywhere(touch))
ok('soundness: (x-1)^2 (x-2)^2 is NOT strictly positive (touches zero)', !positiveEverywhere(touch))
ok('(x-1)^2 (x-2)^2 has two distinct real roots', realRootCount(touch) === 2)

// 12. SOUNDNESS of complete non-negativity: x^2 - 3x + 2 = (x-1)(x-2) DIPS below zero on (1, 2), so it is NOT >= 0
// everywhere -- the cell sample between the roots catches it.
ok('soundness: (x-1)(x-2) is not >= 0 everywhere (dips negative)', !nonNegativeEverywhere([2, -3, 1]))

// 13. a non-negative product of a positive factor and a square: (x^2+1)(x-1)^2 = x^4 - 2x^3 + 2x^2 - 2x + 1 >= 0
// everywhere, not a perfect square -- the complete decision still accepts it.
ok('(x^2+1)(x-1)^2 >= 0 everywhere', nonNegativeEverywhere([1, -2, 2, -2, 1]))

// 14. BOUNDED quantifier: x^2 - 2 is positive on (2, 3) (no root there; sqrt 2 < 2) but NOT on (1, 2) (sqrt 2 is inside,
// and the polynomial is negative just left of it).
ok('x^2 - 2 > 0 on (2, 3)', positiveOnInterval([-2, 0, 1], 2, 3))
ok('soundness: x^2 - 2 is not > 0 on (1, 2) (root sqrt 2 inside)', !positiveOnInterval([-2, 0, 1], 1, 2))

// 15. the STURM-TARSKI query TaQ(g, f) = sum of sign(g) over the real roots of f. For f = x^2 - 1 (roots -1, 1):
// TaQ(1) counts the roots (2); TaQ(x) = sign(-1) + sign(1) = 0; TaQ(x^2) = 1 + 1 = 2 (g is positive at both roots).
ok('Tarski: TaQ(1, x^2 - 1) = 2 (root count)', tarskiQuery([1], [-1, 0, 1]) === 2)
ok('Tarski: TaQ(x, x^2 - 1) = 0 (one positive, one negative root)', tarskiQuery([0, 1], [-1, 0, 1]) === 0)
ok('Tarski: TaQ(x^2, x^2 - 1) = 2 (g positive at both roots)', tarskiQuery([0, 0, 1], [-1, 0, 1]) === 2)

// 16. sign classification of the roots WITHOUT computing them: x^3 - x = x(x-1)(x+1) has roots -1, 0, 1; relative to
// g = x, one is negative (-1), one is zero (0), one is positive (1).
const split = realRootsBySign([0, 1], [0, -1, 0, 1])
ok(
  'Tarski: roots of x^3 - x split by sign(x) into 1 negative, 1 zero, 1 positive',
  split.positive === 1 && split.negative === 1 && split.zero === 1,
)

// 17. a query at IRRATIONAL roots: f = x^2 - 2 (roots +/- sqrt 2); relative to g = x, one root is negative and one is
// positive -- determined exactly though the roots are irrational.
const irr = realRootsBySign([0, 1], [-2, 0, 1])
ok(
  'Tarski: roots of x^2 - 2 split by sign(x) into 1 negative, 1 positive (irrational)',
  irr.positive === 1 && irr.negative === 1 && irr.zero === 0,
)

console.log(`\ncad: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
