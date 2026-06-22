// Coinduction (streams / M-types) via the FUNCTION ENCODING -- the sound route that needs no guarded evaluator. A
// stream over A is `nat -> A` (the final coalgebra / M-type for the functor F X = A x X): `head s = s zero`, `tail s =
// \n. s (succ n)`, and a productive corecursive stream is structural recursion on the index. Coinductive equality
// (BISIMULATION) is exactly function extensionality -- two streams are equal iff they agree at every index -- which the
// kernel already provides (`melt` over a pointwise lemma, sound by observational equality at a function type). So
// observations REDUCE and bisimulations are PROVABLE, with no `cofix` / codata / lazy-unfolding evaluator change.
// Soundness control: two streams that differ at some index are NOT bisimilar (no pointwise lemma, so not equal).
// Run: npx tsx test/check/coinduction.ts

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

task zeros
  take n, like nat
  like nat
  send back
    make zero

task ones
  take n, like nat
  like nat
  send back
    make succ
      bind prior
        make zero

task succ-of-zeros
  take n, like nat
  like nat
  send back
    make succ
      bind prior
        call zeros
          read n

task head
  take s
    like task
      take i, like nat
      like nat
  like nat
  send back
    call s
      make zero
`

// 1. an OBSERVATION reduces: head of the all-ones stream is 1 (= s zero, by application).
ok(
  'stream observation reduces (head ones = 1)',
  compiles(`${PRELUDE}
rule head-ones
  show hold
    call is-equal
      call head
        read ones
      make succ
        bind prior
          make zero
  calm hold
`),
)

// 2. BISIMULATION: succ-of-zeros and ones agree at every index, so they are equal AS STREAMS, proven by funext
// (`melt` over the pointwise lemma). This is coinductive equality.
ok(
  'stream bisimulation via funext (succ-of-zeros == ones)',
  compiles(`${PRELUDE}
rule pointwise
  mark n, like nat
  show hold
    call is-equal
      call succ-of-zeros
        read n
      call ones
        read n
  calm hold

rule bisimilar
  show hold
    call is-equal
      read succ-of-zeros
      read ones
  melt pointwise
`),
)

// 3. SOUNDNESS: zeros and ones differ at every index, so the pointwise equality `zeros n == ones n` is FALSE (zero is
// not succ zero) and cannot be proven -- there is no bisimulation, so they are not equal.
ok(
  'non-bisimilar streams have no pointwise proof (zeros n != ones n)',
  !compiles(`${PRELUDE}
rule false-pointwise
  mark n, like nat
  show hold
    call is-equal
      call zeros
        read n
      call ones
        read n
  calm hold
`),
)

console.log(`\ncoinduction: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
