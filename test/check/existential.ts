// Existential goals: `find x, like T` plus a witness expression proves "there exists x such that P x" by checking P at
// the witness. The witness is bound as a `let`, which now records `x == witness` as a path assumption, so the goal
// discharges through the hypothesis congruence closure. No new surface syntax (the `find` binder already existed); the
// fix is purely the let-binding carrying its value. The soundness control is essential: a wrong witness must NOT prove.
// Run: npx tsx test/check/existential.ts

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

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

const PRELUDE = `form thing
  case a
  case b
`

// 1. A correct witness discharges the existential: there exists x with x = a, witnessed by a.
ok(
  'existential with a correct witness discharges',
  compiles(`${PRELUDE}
rule exists-equal-a
  find x, like thing
    make a
  show hold
    call is-equal
      read x
      make a
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: witness b cannot prove x = a (a and b are distinct). Must be rejected.
ok(
  'existential with a wrong witness is rejected',
  !compiles(`${PRELUDE}
rule exists-equal-a-wrong
  find x, like thing
    make b
  show hold
    call is-equal
      read x
      make a
  calm hold
`),
)

console.log(`\nexistential witness: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
