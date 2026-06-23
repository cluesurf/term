// The CIRCLE as a higher inductive type (HIT). S^1 has one POINT constructor `base` and one PATH constructor
// `loop : base = base`. The path type is the genuine inductive identity family over the circle (`path a b`, with
// `id c : path c c` the reflexivity proof) -- NOT a `mark prop`, so it is not proof-irrelevant and its inhabitants are
// not collapsed. The loop is introduced as a POSTULATE (a bodyless `task` of type `path base base`): the kernel has no
// axiom K (the dependent identity eliminator is not derivable), so the postulated loop is SOUND and stays genuinely
// distinct from `id base` -- the circle does not secretly degenerate to a point. The recursion principle `circ-rec`
// (mapping out by giving a point and a loop in the target) computes on `base`. Run: npx tsx test/check/circle.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form circle
  case base

form path
  head a, like circle
  head b, like circle
  case id
    link c, like circle
    head
      read c
    head
      read c

task loop
  like path
    head
      make base
    head
      make base

form eqn
  head a, like nat
  head b, like nat
  case rfl
    link c, like nat
    head
      read c
    head
      read c

task circ-rec
  take b, like nat
  take l, like eqn
    head
      read b
    head
      read b
  take c, like circle
  like nat
  fork case, read c
    case base
      send back
        read b
`

// 1. the POINT computation rule (the recursor's beta on `base`): circ-rec b l base = b. Here b = 0.
ok(
  'circ-rec computes on base: circ-rec 0 (rfl 0) base == 0',
  compiles(`${PRELUDE}
rule rec-base-zero
  show hold
    call is-equal
      call circ-rec
        make zero
        make rfl
          bind c
            make zero
        make base
      make zero
  calm hold
`),
)

// 2. the same for a non-zero point: circ-rec 1 (rfl 1) base == 1.
ok(
  'circ-rec reads the chosen point: circ-rec 1 (rfl 1) base == 1',
  compiles(`${PRELUDE}
rule rec-base-one
  show hold
    call is-equal
      call circ-rec
        make succ
          bind prior
            make zero
        make rfl
          bind c
            make succ
              bind prior
                make zero
        make base
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. SOUNDNESS of the recursor: circ-rec 1 (rfl 1) base is 1, not 0 -- must be rejected.
ok(
  'soundness: circ-rec 1 (rfl 1) base != 0 is rejected',
  !compiles(`${PRELUDE}
rule rec-base-wrong
  show hold
    call is-equal
      call circ-rec
        make succ
          bind prior
            make zero
        make rfl
          bind c
            make succ
              bind prior
                make zero
        make base
      make zero
  calm hold
`),
)

// 4. NON-TRIVIALITY: the loop is NOT the reflexivity path. `loop == id base` is not provable -- the circle does not
// collapse to a point. (With axiom K it would be provable; the kernel has no K, so this correctly fails to compile.)
ok(
  'non-triviality: loop == id base is NOT provable (the circle is not a point)',
  !compiles(`${PRELUDE}
rule loop-is-refl
  show hold
    call is-equal
      call loop
      make id
        bind c
          make base
  calm hold
`),
)

// 5. the loop is a genuine inhabitant of the identity type `base = base`: a task may return it at that type (the path
// constructor exists and is well-typed), so the HIT really does carry the extra generator.
ok(
  'loop inhabits the identity type base = base (the path constructor is well-typed)',
  compiles(`${PRELUDE}
task use-loop
  like path
    head
      make base
    head
      make base
  send back
    call loop
`),
)

console.log(`\ncircle: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
