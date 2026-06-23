// The identity type as an indexed family. `eq a b` (the proof that a equals b) is the two-index family whose single
// constructor `refl c : eq c c` carries the shared point. It is a first-class TYPE that values inhabit (not only a goal
// discharged by a tactic): `refl` constructs it, and its eliminator computes -- the diagonal recursor `diag : eq a b ->
// nat` reads back the shared point. This is the constructive content of the identity type's recursor (non-dependent J).
// The fully DEPENDENT eliminator (J with a motive `C : (b) -> eq a b -> Type`, i.e. value-level transport) additionally
// needs per-branch refinement of the scrutinee's index variables (the convoy pattern); the substitution form of
// transport -- `a == b |- f a == f b` -- is already proven in `identity-subst.ts`. Run: npx tsx test/check/identity.ts

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

form eq
  head a, like nat
  head b, like nat
  case refl
    link c, like nat
    head
      read c
    head
      read c

task mkrefl
  take n, like nat
  like eq
    head
      read n
    head
      read n
  send back
    make refl
      bind c
        read n

task diag
  take a, like nat
  take b, like nat
  take e, like eq
    head
      read a
    head
      read b
  like nat
  fork case, read e
    case refl
      link c
      send back
        read c
`

// 1. `refl` constructs via a task whose RESULT type is the indexed `eq n n`, and the eliminator computes:
// diag (refl 0) == 0.
ok(
  'refl constructs (eq n n) and the eliminator computes: diag (refl 0) == 0',
  compiles(`${PRELUDE}
rule diag-zero
  show hold
    call is-equal
      call diag
        make zero
        make zero
        call mkrefl
          make zero
      make zero
  calm hold
`),
)

// 2. the eliminator reads back a non-zero point too: diag (refl 1) == 1.
ok(
  'eliminator reads the shared point: diag (refl 1) == 1',
  compiles(`${PRELUDE}
rule diag-one
  show hold
    call is-equal
      call diag
        make succ
          bind prior
            make zero
        make succ
          bind prior
            make zero
        call mkrefl
          make succ
            bind prior
              make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: diag (refl 1) is 1, not 0. Must be rejected.
ok(
  'wrong diagonal value is rejected (diag (refl 1) != 0)',
  !compiles(`${PRELUDE}
rule diag-wrong
  show hold
    call is-equal
      call diag
        make succ
          bind prior
            make zero
        make succ
          bind prior
            make zero
        call mkrefl
          make succ
            bind prior
              make zero
      make zero
  calm hold
`),
)

console.log(`\nidentity: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
