// Dependent function types as datatype fields. A constructor may carry a FUNCTION field whose later parameter's type
// references an EARLIER parameter of the same function (and a sibling field). The accessibility predicate is exactly
// this shape: `acc` carries `n : nat` and `step : (m) -> lt m n -> acc`, where the `step` function's second parameter
// `lt m n` references its own first parameter `m` AND the sibling field `n`. This needs function types to carry their
// parameter names so a dependent reference resolves (a `Pi`, not a bare arrow). The accessibility witness `acc zero`
// builds (its `step` is the ex-falso on `lt m zero`) AND reduces -- projecting its `n` field computes. This is the data
// shape automatic well-founded recursion (`Acc`) is built on. Run: npx tsx test/check/dependent-function-field.ts

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
  case mkacc
    link n, like nat
    link step
      like task
        take m, like nat
        take pf
          like lt
            head
              read m
            head
              read n
        like acc

task acc-zero
  like acc
  send back
    make mkacc
      bind n
        make zero
      bind step
        task s
          take m, like nat
          take pf
            like lt
              head
                read m
              head
                make zero
          like acc
          fork case, read pf

task index
  take a, like acc
  like nat
  fork case, read a
    case mkacc
      link n
      link step
      send back
        read n
`

// 1. the accessibility witness `acc zero` BUILDS (its `step` field is a dependent function whose body ex-falsos on the
// empty `lt m zero`) AND reduces: projecting its index field computes index (acc-zero) == 0.
ok(
  'acc-zero (dependent function field, ex-falso step) builds and projects: index (acc-zero) == 0',
  compiles(`${PRELUDE}
rule index-zero
  show hold
    call is-equal
      call index
        call acc-zero
      make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: index (acc-zero) is 0, not 1. The projection through the dependent-function-field constructor
// must compute the RIGHT value.
ok(
  'wrong projection is rejected (index (acc-zero) != 1)',
  !compiles(`${PRELUDE}
rule index-wrong
  show hold
    call is-equal
      call index
        call acc-zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

console.log(`\ndependent-function-field: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
