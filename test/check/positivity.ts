// Structural positivity -- the nonlinear companion the linear (Fourier-Motzkin) prover lacks. A SQUARE `a * a` is >= 0
// for any value, and sums / products of non-negative parts stay non-negative; these are outside the linear fragment
// (variable*variable) yet trivially true, and the kernel cannot see them either (opaque literals). `holds.ts` now
// discharges a goal `e >= 0` / `e > 0` (and `0 <= e` / `0 < e`) whose non-zero side is structurally non-negative /
// positive. Sound over any ordered ring. Soundness controls: a square is only >= 0 (NOT > 0, the base may be zero),
// and a non-square product (`x * y`) is not certified. Run: npx tsx test/check/positivity.ts

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

// a hold is genuinely PROVEN when the file compiles AND carries no `unchecked-hold` / `unproven` diagnostic for it.
// (A nonlinear goal positivity does NOT prove is left as an `unchecked-hold` warning -- still `ok` -- so checking
// `.ok` alone cannot tell "proven" from "silently unverified". This distinguishes them.)
function compiles(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  if (!result.ok) {
    return false
  }

  return !result.warnings.some(
    w => w.name === 'unchecked-hold' || w.name === 'unproven',
  )
}

// 1. a SQUARE is non-negative: `x * x >= 0` for any integer x (the base's sign is irrelevant).
ok(
  'square is non-negative: x * x >= 0',
  compiles(`rule square-nonneg
  mark x, like integer
  show hold
    call is-minimum
      call multiply
        read x
        read x
      mark 0
  calm hold
`),
)

// 2. a SUM OF SQUARES is non-negative: `x*x + y*y >= 0`.
ok(
  'sum of squares is non-negative: x*x + y*y >= 0',
  compiles(`rule sum-of-squares-nonneg
  mark x, like integer
  mark y, like integer
  show hold
    call is-minimum
      call add
        call multiply
          read x
          read x
        call multiply
          read y
          read y
      mark 0
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: a square is only >= 0, NOT strictly > 0 (it is zero when the base is zero). `x*x > 0` must be
// rejected.
ok(
  'square is not strictly positive: x * x > 0 is rejected',
  !compiles(`rule square-positive-wrong
  mark x, like integer
  show hold
    call is-above
      call multiply
        read x
        read x
      mark 0
  calm hold
`),
)

// 4. SOUNDNESS CONTROL: a non-square product is not certified -- `x * y >= 0` is false for opposite signs and must be
// rejected.
ok(
  'non-square product is not certified: x * y >= 0 is rejected',
  !compiles(`rule product-nonneg-wrong
  mark x, like integer
  mark y, like integer
  show hold
    call is-minimum
      call multiply
        read x
        read y
      mark 0
  calm hold
`),
)

console.log(`\npositivity: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
