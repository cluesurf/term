// Polymorphic datatypes: a `form box / head a` declares a type parameter; `like box / head natural` applies it. The
// datatype is encoded with leading ERASED type-parameter binders (constructors and the eliminator), use sites insert
// the witnesses, and a polymorphic function (fork case over the parameterised subject) is transparent so a structural
// law reduces. Soundness gate: a FALSE polymorphic law must be rejected. (Recursive self-referential parameters -- a
// field `like box / head a` -- are a further step, tracked in the plan; this covers the non-recursive case.)
// Run: npx tsx test/check/polymorphic.ts

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

const PRELUDE = `form natural
  case zero
  case succ
    link prior, like natural

form box
  head a
  case wrap
    link val, like a

task unwrap
  take b, like box
    head natural
  like natural
  fork case, read b
    case wrap
      link val
      send back
        read val
`

// 1. A polymorphic function reduces: unwrap (wrap x) = x, for the box parameterised at natural.
ok(
  'polymorphic projection law reduces',
  compiles(`${PRELUDE}
rule unwrap-wrap
  mark x, like natural
  show hold
    call is-equal
      call unwrap
        make wrap
          bind val
            read x
      read x
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: unwrap (wrap zero) = succ zero is false. Must be rejected.
ok(
  'false polymorphic law is rejected',
  !compiles(`${PRELUDE}
rule unwrap-wrong
  show hold
    call is-equal
      call unwrap
        make wrap
          bind val
            make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// a RECURSIVE polymorphic datatype (a stack with a self-referential tail `like stack / head a`) and a function that
// recurses through it
const STACK = `form natural
  case zero
  case succ
    link prior, like natural

form stack
  head a
  case empty
  case push
    link top, like a
    link rest, like stack
      head a

task depth
  take s, like stack
    head natural
  like natural
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
            call depth
              read rest
`

// 3. RECURSIVE polymorphic reduction: depth (push x s) = succ (depth s).
ok(
  'recursive polymorphic structural law reduces',
  compiles(`${STACK}
rule depth-push
  mark x, like natural
  mark s, like stack
    head natural
  show hold
    call is-equal
      call depth
        make push
          bind top
            read x
          bind rest
            read s
      make succ
        bind prior
          call depth
            read s
  calm hold
`),
)

// 4. SOUNDNESS CONTROL on the recursive case: depth (push x s) = depth s is false. Must be rejected.
ok(
  'false recursive polymorphic law is rejected',
  !compiles(`${STACK}
rule depth-push-wrong
  mark x, like natural
  mark s, like stack
    head natural
  show hold
    call is-equal
      call depth
        make push
          bind top
            read x
          bind rest
            read s
      call depth
        read s
  calm hold
`),
)

// 5. A FIELD-LESS constructor resolves its parameter from FIELD context: depth (push zero empty) = succ zero, where
// `empty`'s element type is fixed by the enclosing `push`.
ok(
  'field-less constructor resolves in field context',
  compiles(`${STACK}
rule depth-singleton
  show hold
    call is-equal
      call depth
        make push
          bind top
            make zero
          bind rest
            make empty
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 6. A FIELD-LESS constructor (`empty`) as a BARE top-level argument resolves its type parameter from the called
// function's parameter type: depth (empty) = zero, where `depth` takes a `stack natural`.
ok(
  'field-less constructor in bare argument position resolves',
  compiles(`${STACK}
rule depth-empty
  show hold
    call is-equal
      call depth
        make empty
      make zero
  calm hold
`),
)

console.log(`\npolymorphic datatypes: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
