// Arithmetic disequality goals (`L != R`) -- an omega/lia-flavored step. The kernel cannot prove arithmetic
// disequalities (it views number literals opaquely, so it can never tell 6 from 8), and the linear prover previously
// declined `!=` entirely. Now a disequality is provable when the assumptions force a STRICT SEPARATION -- `L < R`
// everywhere or `L > R` everywhere -- which is sound over any ordered domain and discharges the recurring "unequal"
// facts (`n + 1 != 0` for a natural n, `i != i + 1`) without a manual case split. Soundness controls: a disequality
// that is NOT a tautology (`n != 0` for a natural n, which could be 0) is rejected, and a CONSTRUCTOR disequality is
// left to the kernel's no-confusion (untouched). Run: npx tsx test/check/disequality.ts

import { compile } from '@term/make/code/compile/compile'

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

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

// 1. `n + 1 != 0` for a NATURAL n: n >= 0 forces n + 1 >= 1 > 0, a strict separation, so the disequality proves.
ok(
  'n + 1 != 0 for a natural n (strict separation above)',
  compiles(`rule succ-not-zero
  mark n, like natural-number
  show hold
    call is-unequal
      call add
        read n
        code 1
      code 0
  calm hold
`),
)

// 2. `n != n + 1` for ANY integer n: n < n + 1 always, a strict separation, so the disequality proves.
ok(
  'n != n + 1 for any integer n (strict separation below)',
  compiles(`rule self-not-successor
  mark n, like integer
  show hold
    call is-unequal
      read n
      call add
        read n
        code 1
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: `n != 0` for a natural n is NOT a tautology (n can be 0). It must be rejected -- there is no
// strict separation (n could equal 0).
ok(
  'non-tautological disequality is rejected (n != 0 for a natural n)',
  !compiles(`rule maybe-zero
  mark n, like natural-number
  show hold
    call is-unequal
      read n
      code 0
  calm hold
`),
)

// 4. SOUNDNESS CONTROL: `n + 1 != 0` over a general INTEGER n is NOT a tautology (n could be -1). It must be rejected.
ok(
  'integer n + 1 != 0 is rejected (n could be -1)',
  !compiles(`rule succ-not-zero-int
  mark n, like integer
  show hold
    call is-unequal
      call add
        read n
        code 1
      code 0
  calm hold
`),
)

// 5. THE OMEGA GCD TEST: `2 a + 4 b != 3` is NOT settled by separation (both sides range over all integers), but the
// equation `2 a + 4 b == 3` has no integer solution -- gcd(2, 4) = 2 does not divide 3 -- so the disequality is a
// theorem. This is the integer-specific rung the rational Fourier-Motzkin prover alone cannot reach.
ok(
  'gcd test: 2a + 4b != 3 (no integer solution, gcd 2 does not divide 3)',
  compiles(`rule gcd-refutes
  mark a, like integer
  mark b, like integer
  show hold
    call is-unequal
      call add
        call multiply
          code 2
          read a
        call multiply
          code 4
          read b
      code 3
  calm hold
`),
)

// 6. SOUNDNESS CONTROL: `2 a + 4 b != 6` must be REJECTED -- gcd(2, 4) = 2 DOES divide 6, so `2 a + 4 b == 6` has an
// integer solution (a = 1, b = 1) and the disequality is false.
ok(
  'gcd test soundness: 2a + 4b != 6 is rejected (a = 1, b = 1 is a solution)',
  !compiles(`rule gcd-allows
  mark a, like integer
  mark b, like integer
  show hold
    call is-unequal
      call add
        call multiply
          code 2
          read a
        call multiply
          code 4
          read b
      code 6
  calm hold
`),
)

console.log(`\ndisequality: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
