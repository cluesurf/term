// Parametricity / free theorems. The general relational translation's CONTENT -- representation independence and the
// naturality of polymorphic functions -- is delivered constructively: a free theorem is proven by the relational
// method (induction over the polymorphic container, using the IH on the tail, for an ARBITRARY element function `f`).
// Here `map f (append s t) == append (map f s) (map f t)` -- the naturality of `append`, a free theorem that holds for
// every `f` because `append` cannot inspect the element type. (The general AUTO-derivation of such theorems from a
// type alone -- the abstraction theorem as a term translation -- is the research-grade remainder; the practical
// free-theorem capability is here.) Soundness control: a false "naturality" with the arguments swapped is rejected.
// Run: npx tsx test/check/parametricity.ts

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

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form stack
  head a
  case empty
  case push
    link top, like a
    link rest, like stack
      head a

task append
  take s, like stack
    head nat
  take t, like stack
    head nat
  like stack
    head nat
  fork case, read s
    case empty
      send back
        read t
    case push
      link top
      link rest
      send back
        make push
          bind top
            read top
          bind rest
            call append
              read rest
              read t

task map
  take f
    like task
      take x, like nat
      like nat
  take s, like stack
    head nat
  like stack
    head nat
  fork case, read s
    case empty
      send back
        make empty
    case push
      link top
      link rest
      send back
        make push
          bind top
            call f
              read top
          bind rest
            call map
              read f
              read rest
`

// 1. the NATURALITY free theorem for append, for an arbitrary element function f, proven by induction over the
// polymorphic container: map f (append s t) == append (map f s) (map f t).
ok(
  'free theorem: map f (append s t) == append (map f s) (map f t)',
  compiles(`${PRELUDE}
rule map-append-natural
  mark f
    like task
      take x, like nat
      like nat
  mark s, like stack
    head nat
  mark t, like stack
    head nat
  show hold
    call is-equal
      call map
        read f
        call append
          read s
          read t
      call append
        call map
          read f
          read s
        call map
          read f
          read t
  fold s
`),
)

// 2. SOUNDNESS CONTROL: the SWAPPED claim map f (append s t) == append (map f t) (map f s) is false in general (append
// is not commutative) and must be rejected.
ok(
  'swapped (false) naturality is rejected',
  !compiles(`${PRELUDE}
rule map-append-wrong
  mark f
    like task
      take x, like nat
      like nat
  mark s, like stack
    head nat
  mark t, like stack
    head nat
  show hold
    call is-equal
      call map
        read f
        call append
          read s
          read t
      call append
        call map
          read f
          read t
        call map
          read f
          read s
  fold s
`),
)

console.log(`\nparametricity: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
