// The identity type's substitution principle (subst / the computational content of J / transport): from a proof that
// `a == b`, any property of `a` transfers to `b`. The kernel discharges this by CONGRUENCE rewriting modulo the
// equation in scope -- `a == b |- f a == f b` for any `f` -- which is exactly transport along the equality. Here the
// equation is introduced as a path hypothesis (a branch on `n == m`), and the goal `is-zero n == is-zero m` (which
// `calm` alone cannot prove, since n and m are distinct variables) is discharged from it. Sound: the assumption is
// true on that path, so rewriting by it preserves truth. Soundness control: WITHOUT the equation, the goal is not
// provable. Run: npx tsx test/check/identity-subst.ts

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

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form bit
  case off
  case on

task is-zero
  take n, like nat
  like bit
  fork case, read n
    case zero
      send back
        make on
    case succ
      link prior
      send back
        make off
`

// 1. SUBST / transport: from the equation `n == m`, derive `is-zero n == is-zero m` (congruence under the function
// `is-zero`). The equation is a path hypothesis (the `n == m` branch).
ok(
  'subst: n == m discharges is-zero n == is-zero m (congruence / J)',
  compiles(`${PRELUDE}
task subst
  take n, like nat
  take m, like nat
  like bit
  fork test
    hook test
      call is-equal
        read n
        read m
    hook hold
      hold
        call is-equal
          call is-zero
            read n
          call is-zero
            read m
      send back
        make on
    hook miss
      send back
        make off
`),
)

// 2. SOUNDNESS CONTROL: WITHOUT the equation in scope, `is-zero n == is-zero m` is NOT provable (n and m are distinct
// free variables, so the congruence has nothing to rewrite by). Must be rejected.
ok(
  'without the equation, the congruence goal is not provable',
  !compiles(`${PRELUDE}
rule no-hypothesis
  mark n, like nat
  mark m, like nat
  show hold
    call is-equal
      call is-zero
        read n
      call is-zero
        read m
  calm hold
`),
)

console.log(`\nidentity-subst: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
