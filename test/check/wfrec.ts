// Well-founded recursion over a FUNCTION-typed field (the W-type / accessibility elimination principle). When an
// inductive constructor carries a function field (`node : (nat -> wtree) -> wtree`, `mkacc : ((m) -> lt m n -> acc m) ->
// acc n`), recursing on the RESULT of applying that field (`kids b`, `step m pf`) descends to a structural CHILD of the
// matched value, which is well-founded. The totality checker now credits this descent, so such a function is total and
// COMPUTES. This is the mechanism that completes general well-founded recursion via accessibility. Soundness: a wrong
// result is rejected, and crediting an inductive (finitely deep) type is sound. Run: npx tsx test/check/wfrec.ts

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

// 3. the GENERIC accessibility recursor `wf-rec` -- the completion of well-founded recursion -- type-checks. It recurses
// on `step y pf` (the sub-accessibility proof drawn from the matched `acc`), with the recursive call carried in a
// continuation closure `\y pf. wf-rec f y (step y pf)`. Closures, dependent fields, and the field-descent credit make
// this expressible and total.
ok(
  'generic accessibility recursor wf-rec type-checks',
  compiles(`form nat
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
  take x, like nat
  take a
    like acc
      head
        read x
  like nat
  fork case, read a
    case mkacc
      link step
      send back
        call f
          read x
          task cont
            take y, like nat
            take pf
              like lt
                head
                  read y
                head
                  read x
            like nat
            send back
              call wf-rec
                read f
                read y
                call step
                  read y
                  read pf
`),
)

console.log(`\nwfrec: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
