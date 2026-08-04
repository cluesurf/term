// Ex falso from an INTEGER-INCONSISTENT assumption -- the integer (omega) dual of the disequality gcd test, applied to
// the assumptions rather than the goal. A branch condition `2 a == 3` records the equation `2 a == 3`, which by Bezout
// has NO integer solution (gcd(2) = 2 does not divide 3). That branch is therefore unreachable, so EVERY hold inside it
// is vacuously true. The rational Fourier-Motzkin prover alone cannot see this (it reads `2 a == 3` as satisfiable at
// a = 3/2). Sound because Seed's binary +/-/* are integer-only, so a coefficient |c| > 1 -- the only case the gcd test
// fires -- guarantees integer variables. Soundness control: under a CONSISTENT assumption (`2 a == 4`, solvable at
// a = 2) the same non-tautological hold is NOT vacuously proven. Run: npx tsx test/check/ex-falso.ts

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

// the dead branch: its condition `2 a == 3` has no integer solution, so the hold `a == 999` inside it is vacuous.
const deadBranch = (rhs: number) => `task branch
  take a, like integer
  like nat
  fork test
    hook test
      call is-equal
        call multiply
          code 2
          read a
        code ${rhs}
    hook hold
      hold
        call is-equal
          read a
          code 999
      send back
        make zero
    hook miss
      send back
        make zero
`

// 1. EX FALSO: the branch assuming `2 a == 3` (no integer solution) proves an otherwise-false hold vacuously.
ok(
  'integer-inconsistent assumption (2a == 3) makes the branch vacuous',
  compiles(deadBranch(3)),
)

// 2. SOUNDNESS CONTROL: the branch assuming `2 a == 4` (solvable at a = 2) is LIVE, so the non-tautological hold
// `a == 999` is NOT proven and the function is rejected.
ok(
  'consistent assumption (2a == 4) does NOT prove the false hold',
  !compiles(deadBranch(4)),
)

console.log(`\nex-falso: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
