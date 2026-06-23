// VALUE-level transport (the dependent identity eliminator, J). From a proof `eq a b` and a value in `P a`, produce a
// value in `P b`. This is the convoy: a match on the equality proof whose result type is the FUNCTION `P a -> P b`, so
// the dependent motive ABSTRACTS over the scrutinee's indices (`\i0 i1 x. vecnat i0 -> vecnat i1`); the `refl` branch is
// then checked at `vecnat c -> vecnat c` and returns the identity. Two pieces made this expressible: a function type's
// parameter / result indices are now preserved (`vecnat a -> vecnat b`, the fifth `head`->valueArgs site), and the
// non-inversion motive abstracts over index variables. Soundness: transporting WITHOUT the equality proof is rejected.
// Run: npx tsx test/check/transport.ts

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

form vecnat
  head n, like nat
  case vnil
    head
      make zero
  case vcons
    link count, like nat
    link item, like nat
    link rest, like vecnat
      head
        read count
    head
      make succ
        bind prior
          read count

form eq
  head a, like nat
  head b, like nat
  case refl
    link c, like nat
    head
      read c
    head
      read c

task transport-fn
  take a, like nat
  take b, like nat
  take e, like eq
    head
      read a
    head
      read b
  like task
    take w, like vecnat
      head
        read a
    like vecnat
      head
        read b
  fork case, read e
    case refl
      link c
      send back
        task id
          take w, like vecnat
            head
              read c
          like vecnat
            head
              read c
          send back
            read w
`

// 1. the CONVOY itself type-checks: a match on `eq a b` returning the function `vecnat a -> vecnat b`, via the
// abstracting motive. The `refl` branch returns the identity at the refined index.
ok(
  'convoy type-checks: eq a b -> (vecnat a -> vecnat b)',
  compiles(PRELUDE),
)

// 2. full VALUE transport `eq a b -> vecnat a -> vecnat b` type-checks (apply the convoy function to the value).
ok(
  'value transport type-checks: eq a b -> vecnat a -> vecnat b',
  compiles(`${PRELUDE}
task transport
  take a, like nat
  take b, like nat
  take e, like eq
    head
      read a
    head
      read b
  take v, like vecnat
    head
      read a
  like vecnat
    head
      read b
  save f
    call transport-fn
      read a
      read b
      read e
  send back
    call f
      read v
`),
)

const TRANSPORT = `${PRELUDE}
task transport
  take a, like nat
  take b, like nat
  take e, like eq
    head
      read a
    head
      read b
  take v, like vecnat
    head
      read a
  like vecnat
    head
      read b
  save f
    call transport-fn
      read a
      read b
      read e
  send back
    call f
      read v
`

// 3. the COMPUTATION rule `transport refl x = x`: transporting along reflexivity returns the value unchanged, and this
// reduces definitionally -- transport (refl 0) nil == nil. (This needs `save`-bound tasks to reduce in proofs, which
// they now do.)
ok(
  'transport computes: transport (refl 0) nil == nil',
  compiles(`${TRANSPORT}
rule transport-refl
  show hold
    call is-equal
      call transport
        make zero
        make zero
        make refl
          bind c
            make zero
        make vnil
      make vnil
  calm hold
`),
)

// 4. SOUNDNESS CONTROL: a value of `vecnat a` may NOT be returned as `vecnat b` WITHOUT an `eq a b` proof. Transport is
// the only bridge; forging it (just `send back v`) must be rejected.
ok(
  'transport without the equality proof is rejected',
  !compiles(`${PRELUDE}
task bad-transport
  take a, like nat
  take b, like nat
  take v, like vecnat
    head
      read a
  like vecnat
    head
      read b
  send back
    read v
`),
)

console.log(`\ntransport: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
