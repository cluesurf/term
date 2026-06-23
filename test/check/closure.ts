// First-class function values (inline closures / lambdas). A closure `task f / take .. like .. / like .. / <body>`
// written in VALUE position elaborates to a kernel LAMBDA from its own type annotations, so it can be passed to a
// higher-order function and APPLIED (beta-reduced) inside a proof, and can fill a higher-order CONSTRUCTOR FIELD with a
// DEPENDENT parameter type. This was the recurring gate for the generic well-founded recursor and for building
// accessibility witnesses. Run: npx tsx test/check/closure.ts

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

const NAT = `form nat
  case zero
  case succ
    link prior, like nat
`

const TWICE = `${NAT}
task twice
  take f, like task
    take x, like nat
    like nat
  take x, like nat
  like nat
  send back
    call f
      call f
        read x
`

// 1. an inline closure passed to a higher-order function REDUCES when applied: twice (\x. succ x) 0 == 2.
ok(
  'inline closure reduces through a higher-order function (twice g 0 == 2)',
  compiles(`${TWICE}
rule use-closure
  show hold
    call is-equal
      call twice
        task g
          take x, like nat
          like nat
          send back
            make succ
              bind prior
                read x
        make zero
      make succ
        bind prior
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: twice (\x. succ x) 0 is 2, not 3. The closure must reduce to the RIGHT value.
ok(
  'closure reduces to the correct value (twice g 0 != 3)',
  !compiles(`${TWICE}
rule use-closure-wrong
  show hold
    call is-equal
      call twice
        task g
          take x, like nat
          like nat
          send back
            make succ
              bind prior
                read x
        make zero
      make succ
        bind prior
          make succ
            bind prior
              make succ
                bind prior
                  make zero
  calm hold
`),
)

// the `a < b` proof and the accessibility predicate `acc n`, whose `mkacc` constructor takes a HIGHER-ORDER field
// `step : (m) -> lt m n -> acc m` -- a function returning the family at another index, with a DEPENDENT parameter type.
const ACC = `${NAT}
form lt
  head a, like nat
  head b, like nat
  case ltself
    link q, like nat
    head
      read q
    head
      make succ
        bind prior
          read q
  case ltmore
    link x, like nat
    link y, like nat
    link sub, like lt
      head
        read x
      head
        read y
    head
      read x
    head
      make succ
        bind prior
          read y

form acc
  head n, like nat
  case mkacc
    link step, like task
      take m, like nat
      take pf, like lt
        head
          read m
        head
          read n
      like acc
        head
          read m
`

// 3. build a real accessibility witness `acc zero`: its step is an inline closure whose parameter `pf : lt m zero` is
// uninhabited, so the body is an empty (ex-falso) match. This needs the closure's DEPENDENT parameter type AND the
// higher-order constructor field to both carry their real types.
ok(
  'accessibility witness acc-zero builds from a dependent inline closure (ex-falso step)',
  compiles(`${ACC}
task acc-zero
  like acc
    head
      make zero
  send back
    make mkacc
      bind step
        task f
          take m, like nat
          take pf, like lt
            head
              read m
            head
              make zero
          like acc
            head
              read m
          fork case, read pf
`),
)

console.log(`\nclosure: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
