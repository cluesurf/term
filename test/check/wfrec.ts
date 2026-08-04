// Well-founded recursion over a FUNCTION-typed field (the W-type / accessibility elimination principle). When an
// inductive constructor carries a function field (`node : (nat -> wtree) -> wtree`, `mkacc : ((m) -> lt m n -> acc m) ->
// acc n`), recursing on the RESULT of applying that field (`kids b`, `step m pf`) descends to a structural CHILD of the
// matched value, which is well-founded. The totality checker now credits this descent, so such a function is total and
// COMPUTES. This is the mechanism that completes general well-founded recursion via accessibility. Soundness: a wrong
// result is rejected, and crediting an inductive (finitely deep) type is sound. Run: npx tsx test/check/wfrec.ts

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

const WTREE = `form nat
  case zero
  case succ
    link prior, like nat

form wtree
  case leaf
  case node
    link kids
      like task
        take b, like nat
        like wtree

task depth
  take t, like wtree
  like nat
  fork case, read t
    case leaf
      send back
        make zero
    case node
      link kids
      send back
        make succ
          bind prior
            call depth
              call kids
                make zero

task mk-leaf-tree
  like wtree
  send back
    make node
      bind kids
        task k
          take b, like nat
          like wtree
          send back
            make leaf
`

// 1. W-type recursion COMPUTES: `depth` recurses on `kids b` (the function field applied), which the totality checker
// now credits as a structural descent. depth (node (\_. leaf)) == 1.
ok(
  'W-type / function-field recursion computes: depth (node (\\_. leaf)) == 1',
  compiles(`${WTREE}
rule depth-ok
  show hold
    call is-equal
      call depth
        call mk-leaf-tree
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: depth (node (\_. leaf)) is 1, not 0. The recursion must compute the RIGHT value.
ok(
  'wrong W-recursion value is rejected (depth != 0)',
  !compiles(`${WTREE}
rule depth-wrong
  show hold
    call is-equal
      call depth
        call mk-leaf-tree
      make zero
  calm hold
`),
)

// the GENERIC accessibility recursor `wf-rec` -- the completion of well-founded recursion -- and a concrete
// accessibility witness `acc-zero`, so it can be EXECUTED end to end (not only type-checked). `acc` is the accessibility
// predicate (its `step` field is a dependent function `(m) -> lt m n -> acc`), `acc-zero` is the witness for 0 (its step
// ex-falsos on `lt m zero`), and `wf-rec f a` recurses on `step y pf` -- the sub-accessibility proof from the matched
// `acc` -- carried in a continuation closure `\y pf. wf-rec f (step y pf)` passed to the step function `f`. This brings
// together every piece built for it: dependent function types, the dependent ex-falso field, inline closures capturing
// a dependent type, the higher-order call, and the field-descent termination credit.
const ACC_REC = `form nat
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

task const-zero
  take x, like nat
  take rec
    like task
      take y, like nat
      take pf
        like lt
          head
            read y
          head
            read x
      like nat
  like nat
  send back
    make zero

task wf-rec
  take f
    like task
      take x, like nat
      take rec
        like task
          take y, like nat
          take pf
            like lt
              head
                read y
              head
                read x
          like nat
      like nat
  take a, like acc
  like nat
  fork case, read a
    case mkacc
      link n
      link step
      send back
        call f
          read n
          task cont
            take y, like nat
            take pf
              like lt
                head
                  read y
                head
                  read n
            like nat
            send back
              call wf-rec
                read f
                call step
                  read y
                  read pf
`

// 3. AUTOMATIC ACC: the generic recursor EXECUTES on a real accessibility witness -- wf-rec const-zero (acc-zero) == 0.
ok(
  'generic accessibility recursor wf-rec executes end-to-end: wf-rec const-zero (acc-zero) == 0',
  compiles(`${ACC_REC}
rule wfrec-ok
  show hold
    call is-equal
      call wf-rec
        read const-zero
        call acc-zero
      make zero
  calm hold
`),
)

// 4. SOUNDNESS CONTROL: wf-rec const-zero (acc-zero) is 0, not 1. The recursor's execution must compute the RIGHT value.
ok(
  'wrong wf-rec result is rejected (wf-rec const-zero (acc-zero) != 1)',
  !compiles(`${ACC_REC}
rule wfrec-wrong
  show hold
    call is-equal
      call wf-rec
        read const-zero
        call acc-zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

console.log(`\nwfrec: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
