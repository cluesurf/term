// Univariate quadratic non-negativity -- the nonlinear `nia` decision the linear prover and the syntactic-square test
// both miss. A real quadratic a*x^2 + b*x + c is >= 0 for ALL x iff a > 0 and discriminant b^2 - 4ac <= 0 (the parabola
// opens up and never crosses zero), or it is a non-negative constant. Real non-negativity implies integer
// non-negativity, so the verdict is sound for Seed's integer variables, and it is COMPLETE for the univariate quadratic
// fragment. `holds.ts` forms `L - R` and runs the discriminant test, so it catches forms NOT written as a square --
// `(x-1)^2` as `x^2 + 1 >= 2x`. Soundness controls: a quadratic with positive discriminant (`x^2 >= 2x`, false at
// x = 1) is not proven, and a downward parabola is not proven. Run: npx tsx test/check/quadratic.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

// a hold is genuinely PROVEN when it compiles with no `unchecked-hold` / `unproven` diagnostic (a nonlinear goal the
// test does NOT prove is left unchecked -- still `ok` -- so `.ok` alone cannot tell proven from silently unverified).
function proven(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  if (!result.ok) {
    return false
  }

  return !result.warnings.some(
    w => w.name === 'unchecked-hold' || w.name === 'unproven',
  )
}

// 1. a PERFECT-SQUARE TRINOMIAL not written as a square: x^2 + 1 >= 2x  is  (x-1)^2 >= 0 (discriminant 0).
ok(
  'perfect-square trinomial: x^2 + 1 >= 2x  ((x-1)^2)',
  proven(`rule square-trinomial
  mark x, like integer
  show hold
    call is-minimum
      call add
        call multiply
          read x
          read x
        mark 1
      call multiply
        mark 2
        read x
  calm hold
`),
)

// 2. a strictly POSITIVE quadratic: x^2 + 1 > 0 (a = 1 > 0, discriminant -4 < 0).
ok(
  'strictly positive quadratic: x^2 + 1 > 0',
  proven(`rule positive-quadratic
  mark x, like integer
  show hold
    call is-above
      call add
        call multiply
          read x
          read x
        mark 1
      mark 0
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: x^2 >= 2x has positive discriminant (b^2 - 4ac = 4 > 0); it is FALSE at x = 1 (1 < 2). Must not
// be proven.
ok(
  'quadratic with positive discriminant is not proven (x^2 >= 2x)',
  !proven(`rule not-everywhere
  mark x, like integer
  show hold
    call is-minimum
      call multiply
        read x
        read x
      call multiply
        mark 2
        read x
  calm hold
`),
)

// 4. SOUNDNESS CONTROL: a downward parabola 0 >= x^2 (i.e. x^2 <= 0) is false for x != 0 and must not be proven.
ok(
  'downward / non-positive quadratic is not proven (x^2 <= 0)',
  !proven(`rule downward
  mark x, like integer
  show hold
    call is-maximum
      call multiply
        read x
        read x
      mark 0
  calm hold
`),
)

// 5. MULTIVARIATE sum-of-squares: a^2 + b^2 >= 2ab  is  (a-b)^2 >= 0 -- the bivariate perfect square, proven by the
// positive-semidefiniteness of the quadratic form (every principal minor >= 0), no square named.
ok(
  'bivariate sum-of-squares: a^2 + b^2 >= 2ab  ((a-b)^2)',
  proven(`rule sos-bivariate
  mark a, like integer
  mark b, like integer
  show hold
    call is-minimum
      call add
        call multiply
          read a
          read a
        call multiply
          read b
          read b
      call multiply
        mark 2
        call multiply
          read a
          read b
  calm hold
`),
)

// 6. SOUNDNESS CONTROL: a^2 + b^2 >= 3ab is NOT positive semidefinite (false at a = b = 1: 2 < 3). Must not be proven.
ok(
  'bivariate form that is not PSD is not proven (a^2 + b^2 >= 3ab)',
  !proven(`rule sos-too-strong
  mark a, like integer
  mark b, like integer
  show hold
    call is-minimum
      call add
        call multiply
          read a
          read a
        call multiply
          read b
          read b
      call multiply
        mark 3
        call multiply
          read a
          read b
  calm hold
`),
)

// 7. HIGHER-DEGREE diagonal sum-of-squares: a^4 + b^4 >= 0 (degree 4, every monomial an even power) -- proven beyond
// the quadratic fragment by the even-monomial certificate.
ok(
  'degree-4 diagonal SOS: a^4 + b^4 >= 0',
  proven(`rule quartic-sos
  mark a, like integer
  mark b, like integer
  show hold
    call is-minimum
      call add
        call multiply
          call multiply
            read a
            read a
          call multiply
            read a
            read a
        call multiply
          call multiply
            read b
            read b
          call multiply
            read b
            read b
      mark 0
  calm hold
`),
)

// 8. SOUNDNESS CONTROL: a^4 >= b^4 is false (a = 0, b = 1 gives 0 < 1); the difference has a negative even-power
// monomial, so it is not certified and must not be proven.
ok(
  'degree-4 non-tautology is not proven (a^4 >= b^4)',
  !proven(`rule quartic-wrong
  mark a, like integer
  mark b, like integer
  show hold
    call is-minimum
      call multiply
        call multiply
          read a
          read a
        call multiply
          read a
          read a
      call multiply
        call multiply
          read b
          read b
        call multiply
          read b
          read b
  calm hold
`),
)

console.log(`\nquadratic: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
