// Lexicographic termination (the foetus criterion): a recursive function where NO single argument decreases on every
// call, but the argument TUPLE decreases lexicographically, is now verified terminating and made transparent. Ackermann
// is the canonical case: ack(m, n) recurses on (m-1, ..) and on (m, n-1) -- m alone does not always decrease, but (m, n)
// does lexicographically. Soundness control: a swap recursion `bad(a, b) = bad(b, a)` does NOT descend at any position
// and must NOT be made transparent, so a law over it does not discharge. Run: npx tsx test/check/lexicographic.ts

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

const NAT = `form nat
  case zero
  case succ
    link prior, like nat
`

// 1. Ackermann reduces: ack(1, 0) = ack(0, 1) = 2 -- only if ack is transparent (lexicographic termination verified).
ok(
  'Ackermann (lexicographic) reduces',
  compiles(`${NAT}
task ack
  take m, like nat
  take n, like nat
  like nat
  fork case, read m
    case zero
      send back
        make succ
          bind prior
            read n
    case succ
      link mp
      fork case, read n
        case zero
          send back
            call ack
              read mp
              make succ
                bind prior
                  make zero
        case succ
          link np
          send back
            call ack
              read mp
              call ack
                read m
                read np

rule ack-one-zero
  show hold
    call is-equal
      call ack
        make succ
          bind prior
            make zero
        make zero
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: a swap recursion does not descend at any position, so `bad` must stay opaque and a law over it
// must NOT discharge.
ok(
  'non-descending swap recursion is not made transparent',
  !compiles(`${NAT}
task bad
  take a, like nat
  take b, like nat
  like nat
  send back
    call bad
      read b
      read a

rule bad-identity
  mark x, like nat
  mark y, like nat
  show hold
    call is-equal
      call bad
        read x
        read y
      read x
  calm hold
`),
)

console.log(`\nlexicographic termination: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
