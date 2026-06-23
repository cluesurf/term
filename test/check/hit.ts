// Higher inductive types -- type formers with EQUALITY constructors. The PROPOSITIONAL TRUNCATION `|| A ||` is the
// (-1)-truncation HIT: an inclusion `| _ | : A -> ||A||` together with the squash path constructor `(x y : ||A||) ->
// x = y` that makes ANY two elements equal (forgetting all structure, keeping only "A is inhabited"). It is declared
// `mark prop`, and the kernel's proof-irrelevance gives the squash definitionally: in `||nat||`, `wrap 0 == wrap 1`
// even though `0 != 1` in `nat` itself. The universal property holds -- a map out of the truncation into any other
// proposition factors through the inclusion. Run: npx tsx test/check/hit.ts

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

// `squash` is `||nat||`: a `mark prop` type with an inclusion constructor `wrap : nat -> squash`.
const PRELUDE = `form nat
  case zero
  case succ
    link prior, like nat

form squash
  mark prop
  case wrap
    link val, like nat
`

// 1. the truncation COLLAPSES: any two elements are equal -- wrap 0 == wrap 1 in ||nat||.
ok(
  'propositional truncation collapses: wrap 0 == wrap 1',
  compiles(`${PRELUDE}
rule collapse
  show hold
    call is-equal
      make wrap
        bind val
          make zero
      make wrap
        bind val
          make succ
            bind prior
              make zero
  calm hold
`),
)

// 2. SOUNDNESS: the truncation does NOT leak -- `nat` itself keeps its real equality, so `0 == 1` is still rejected.
ok(
  'the truncation does not leak (0 == 1 in nat is rejected)',
  !compiles(`${PRELUDE}
rule leak
  show hold
    call is-equal
      make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 3. UNIVERSAL PROPERTY: a map out of the truncation into another proposition factors through the inclusion, and (since
// the target is a prop) sends every element to the same value.
ok(
  'universal property: a map into a prop respects the collapse',
  compiles(`${PRELUDE}
form answer
  mark prop
  case yes

task to-answer
  take s, like squash
  like answer
  fork case, read s
    case wrap
      link val
      send back
        make yes

rule rec
  show hold
    call is-equal
      call to-answer
        make wrap
          bind val
            make zero
      call to-answer
        make wrap
          bind val
            make succ
              bind prior
                make zero
  calm hold
`),
)

console.log(`\nhit: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
