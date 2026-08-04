// Linear / commutative-ring identities under `calm hold`: the ring normalizer (a sound decision procedure for the
// +/-/* integer fragment, omega/lia for the equality case) is reached not only by a bare hold but also as a FALLBACK
// when an explicit `calm` tactic does not close by definitional equality. So a user can write `calm hold` for a law
// like `add a b == add b a` without knowing to drop the tactic. Soundness: a false linear claim is still rejected.
// Run: npx tsx test/check/linear-arithmetic.ts

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

// 1. commutativity of addition, proven with an explicit `calm hold` (ring fallback).
ok(
  'add commutes under calm hold',
  compiles(`rule add-commutes
  mark a, like integer
  mark b, like integer
  show hold
    call is-equal
      call add
        read a
        read b
      call add
        read b
        read a
  calm hold
`),
)

// 2. a linear rearrangement: (x + y) + x == (x + x) + y.
ok(
  'linear rearrangement under calm hold',
  compiles(`rule linear-cancel
  mark x, like integer
  mark y, like integer
  show hold
    call is-equal
      call add
        call add
          read x
          read y
        read x
      call add
        call add
          read x
          read x
        read y
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: a + a == a is false. Must be rejected even under calm hold.
ok(
  'false linear claim is rejected',
  !compiles(`rule false-linear
  mark a, like integer
  show hold
    call is-equal
      call add
        read a
        read a
      read a
  calm hold
`),
)

console.log(`\nlinear arithmetic: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
