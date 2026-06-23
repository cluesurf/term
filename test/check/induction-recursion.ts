// Induction-recursion: a universe as DATA. A type `univ` of CODES and a decoder `el : univ -> type` (a type-returning
// function) defined together, where `el` is recursive on `univ`. `el natcode = nat`, `el boolcode = bool`, and for a
// recursive code `el (listcode c) = el c`. The decoder COMPUTES: `el (listcode natcode) == nat`. This is the road to a
// universe-as-data / intrinsically-typed syntax. Three pieces make it work: `type` is the UNIVERSE (a first-class type
// of types, kept through inference and lowered to Type0); a TYPE used as a value resolves to its self-encoding (so a
// branch may return `nat`); and a type-RETURNING match uses the LARGE eliminator `matchType` (motive into Type1), so a
// branch may itself be a type. Soundness: `el natcode = nat`, NOT `bool`. Run: npx tsx test/check/induction-recursion.ts

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

form bool
  case true
  case false

form univ
  case natcode
  case boolcode
  case listcode
    link elem, like univ

task el
  take u, like univ
  like type
  fork case, read u
    case natcode
      send back
        read nat
    case boolcode
      send back
        read bool
    case listcode
      link elem
      send back
        call el
          read elem
`

// 1. the decoder COMPUTES at a base code: el natcode == nat (as types).
ok(
  'universe decoder computes: el natcode == nat',
  compiles(`${PRELUDE}
rule el-nat
  show hold
    call is-equal
      call el
        make natcode
      read nat
  calm hold
`),
)

// 2. the RECURSIVE decoder computes: el (listcode natcode) == nat -- `el` calls itself on the sub-code.
ok(
  'recursive decoder computes: el (listcode natcode) == nat',
  compiles(`${PRELUDE}
rule el-list
  show hold
    call is-equal
      call el
        make listcode
          bind elem
            make natcode
      read nat
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: el natcode is nat, NOT bool. The decoder must compute the right type.
ok(
  'decoder is sound (el natcode != bool)',
  !compiles(`${PRELUDE}
rule el-wrong
  show hold
    call is-equal
      call el
        make natcode
      read bool
  calm hold
`),
)

// the decoder used IN A TYPE position -- TYPE-LEVEL APPLICATION. `identity-at : (a : univ) -> el a -> el a` takes a value
// of the DECODED type `el a` and returns it. `el a` is the function `el` applied inside a type, reducing to the type the
// code denotes.
const TLAPP = `${PRELUDE}
task identity-at
  take a, like univ
  take x
    like el
      head
        read a
  like el
    head
      read a
  send back
    read x
`

// 4. type-level application COMPUTES: identity-at natcode 1 == 1, where the argument has type el natcode = nat.
ok(
  'type-level application of the decoder computes: identity-at natcode 1 == 1',
  compiles(`${TLAPP}
rule idat
  show hold
    call is-equal
      call identity-at
        make natcode
        make succ
          bind prior
            make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 5. SOUNDNESS CONTROL: the decoded type is ENFORCED -- el natcode is nat, so `identity-at natcode true` (true : bool)
// must be rejected.
ok(
  'type-level application enforces the decoded type (identity-at natcode true is rejected)',
  !compiles(`${TLAPP}
task bad
  like univ
  send back
    call identity-at
      make natcode
      make true
`),
)

// FULL induction-recursion: the universe's CONSTRUCTOR references the decoder. `sigcode` carries a code `base` and a
// VALUE of the decoded type (`val : el base`), so `univ` is defined SIMULTANEOUSLY with `el` -- each mentions the other.
// `el (sigcode base v) = el base`. This is the defining shape of induction-recursion (a type and a function on it
// defined together, the type's constructors using the function). The large eliminator's branch field types now carry the
// preceding-field scope, so `el base` (a type-level application referencing a sibling) resolves.
const FULL = `form nat
  case zero
  case succ
    link prior, like nat

form bool
  case true
  case false

form univ
  case natcode
  case sigcode
    link base, like univ
    link val
      like el
        head
          read base

task el
  take u, like univ
  like type
  fork case, read u
    case natcode
      send back
        read nat
    case sigcode
      link base
      link val
      send back
        call el
          read base
`

// 6. the decoder computes through a constructor that REFERENCES it: el (sigcode natcode 1) == nat.
ok(
  'full induction-recursion: constructor references decoder, el (sigcode natcode 1) == nat',
  compiles(`${FULL}
rule el-sig
  show hold
    call is-equal
      call el
        make sigcode
          bind base
            make natcode
          bind val
            make succ
              bind prior
                make zero
      read nat
  calm hold
`),
)

// 7. SOUNDNESS CONTROL: the decoder-referencing field is ENFORCED -- `sigcode natcode true` has `val : el natcode = nat`,
// so a `bool` value is rejected.
ok(
  'constructor decoder-field enforces the decoded type (sigcode natcode true is rejected)',
  !compiles(`${FULL}
task bad-sig
  like univ
  send back
    make sigcode
      bind base
        make natcode
      bind val
        make true
`),
)

console.log(`\ninduction-recursion: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
