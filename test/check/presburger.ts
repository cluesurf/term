// Presburger arithmetic -- INTEGER-exact linear reasoning (the divisibility core). The linear prover eliminates
// variables by Fourier-Motzkin (existential quantifier elimination), but over the rationals that is INCOMPLETE for the
// integers: `2x = 3` has the rational solution x = 1.5, yet NO integer solution. The Omega-style INTEGER TIGHTENING
// added to `normalize` closes that gap: a constraint `Sigma <= b` whose coefficients share a gcd `g` is EXACTLY
// `Sigma <= g * floor(b / g)`, since `Sigma` is always a multiple of `g`. With it the prover DECIDES divisibility --
// `2x = 3` becomes `x <= 1 AND x >= 2`, a contradiction. It stays sound (a genuinely satisfiable system, `2x = 4`, is
// not refuted). This is the integer-completeness half of Presburger (full modular projection for free multi-variable
// divisibility, `2x = y => y even`, is the remaining Omega dark-shadow piece). Run: npx tsx test/check/presburger.ts

import {
  linear,
  atMost,
  atLeast,
  below,
  proves,
} from '@cluesurf/make/code/check/refine'

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

const x = linear({ x: 1 })
const twoX = linear({ x: 2 })
const k = (n: number) => linear({}, n)
const contradiction = below(k(0), k(0)) // 0 < 0, an unprovable goal -- proven only if the assumptions are unsat

// 1. divisibility: 2x == 3 has no INTEGER solution, so the system is unsatisfiable (Fourier-Motzkin over the rationals
// would accept x = 1.5).
ok(
  'integer: 2x = 3 is unsatisfiable (divisibility)',
  proves([atMost(twoX, k(3)), atLeast(twoX, k(3))], contradiction),
)

// 2. SOUNDNESS: 2x == 4 DOES have an integer solution (x = 2), so the system must NOT be refuted.
ok(
  'soundness: 2x = 4 is satisfiable (not refuted)',
  !proves([atMost(twoX, k(4)), atLeast(twoX, k(4))], contradiction),
)

// 3. integer floor: 2x <= 3 implies x <= 1 (since x <= 1.5 and x is an integer). Over the rationals it would not.
ok('integer: 2x <= 3 implies x <= 1', proves([atMost(twoX, k(3))], atMost(x, k(1))))

// 4. SOUNDNESS: 2x <= 3 does NOT imply x <= 0 (x = 1 satisfies the premise).
ok(
  'soundness: 2x <= 3 does not imply x <= 0',
  !proves([atMost(twoX, k(3))], atMost(x, k(0))),
)

// 5. divisibility with a larger modulus: 4x = 6 is unsatisfiable over the integers (gcd 4 does not divide 6).
ok(
  'integer: 4x = 6 is unsatisfiable',
  proves([atMost(linear({ x: 4 }), k(6)), atLeast(linear({ x: 4 }), k(6))], contradiction),
)

// 6. SOUNDNESS: 3x = 6 is satisfiable (x = 2).
ok(
  'soundness: 3x = 6 is satisfiable (not refuted)',
  !proves([atMost(linear({ x: 3 }), k(6)), atLeast(linear({ x: 3 }), k(6))], contradiction),
)

const y = linear({ y: 1 })
const eq = (a: ReturnType<typeof linear>, b: ReturnType<typeof linear>) => [
  atMost(a, b),
  atLeast(a, b),
]

// 7. MULTI-VARIABLE divisibility: 2x = y AND y = 3 is unsatisfiable -- exact (unit-coefficient) elimination of `y`
// reduces it to 2x = 3, which the integer tightening then refutes. Plain Fourier-Motzkin, eliminating `x` first, would
// lose the `2 | y` information and wrongly accept it.
ok(
  'multivar: 2x = y AND y = 3 is unsatisfiable',
  proves([...eq(twoX, y), ...eq(y, k(3))], contradiction),
)

// 8. SOUNDNESS: 2x = y AND y = 4 is satisfiable (x = 2, y = 4).
ok(
  'soundness: 2x = y AND y = 4 is satisfiable (not refuted)',
  !proves([...eq(twoX, y), ...eq(y, k(4))], contradiction),
)

// 9. CHAINED: 2x = y, 2y = z, z = 2 forces y = 1, then 2x = 1 -- unsatisfiable through two exact eliminations.
ok(
  'chained: 2x = y, 2y = z, z = 2 is unsatisfiable',
  proves(
    [
      ...eq(twoX, y),
      ...eq(linear({ y: 2 }), linear({ z: 1 })),
      ...eq(linear({ z: 1 }), k(2)),
    ],
    contradiction,
  ),
)

// 10. multi-variable GCD: 2x + 4y = 1 is unsatisfiable -- gcd(2,4)=2 does not divide 1, caught directly by the tightening.
ok(
  'multivar gcd: 2x + 4y = 1 is unsatisfiable',
  proves([...eq(linear({ x: 2, y: 4 }), k(1))], contradiction),
)

console.log(`\npresburger: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
