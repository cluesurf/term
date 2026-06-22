// Polymorphic structural induction: `fold` over a value of a POLYMORPHIC datatype (`stack a`). The induction machinery
// previously bailed because the variable's type is `apply(stack, natural)` (tag 'app'), not a bare constant, and built
// constructor values without the erased type-parameter witnesses. It now peels the type former (`headConstantName`),
// inserts the witnesses, and recognises recursive fields by their type former -- so structural induction over a
// polymorphic container works (and polymorphic functions over it reduce). Run: npx tsx test/check/polymorphic-induction.ts

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

form stack
  head a
  case empty
  case push
    link top, like a
    link rest, like stack
      head a

task length
  take s, like stack
    head nat
  like nat
  fork case, read s
    case empty
      send back
        make zero
    case push
      link top
      link rest
      send back
        make succ
          bind prior
            call length
              read rest

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
`

// 1. structural induction over the polymorphic stack closes a reflexive goal (the induction splits + each case reduces).
ok(
  'fold over a polymorphic datatype works',
  compiles(`${PRELUDE}
rule length-refl
  mark s, like stack
    head nat
  show hold
    call is-equal
      call length
        read s
      call length
        read s
  fold s
`),
)

// 2. a polymorphic recursive function reduces (append over the parameterised stack).
ok(
  'polymorphic recursive function reduces',
  compiles(`${PRELUDE}
rule append-empty
  mark t, like stack
    head nat
  show hold
    call is-equal
      call append
        make empty
        read t
      read t
  calm hold
`),
)

// 3. the LENGTH HOMOMORPHISM -- the key length-indexed-vector shape law -- proven by INDUCTION over a polymorphic
// container, USING the induction hypothesis on the recursive tail: length (append s t) = length s + length t.
ok(
  'length-append homomorphism over a polymorphic container (IH-using)',
  compiles(`${PRELUDE}
task plus
  take a, like nat
  take b, like nat
  like nat
  fork case, read a
    case zero
      send back
        read b
    case succ
      link prior
      send back
        make succ
          bind prior
            call plus
              read prior
              read b

rule length-append
  mark s, like stack
    head nat
  mark t, like stack
    head nat
  show hold
    call is-equal
      call length
        call append
          read s
          read t
      call plus
        call length
          read s
        call length
          read t
  fold s
`),
)

console.log(`\npolymorphic induction: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
