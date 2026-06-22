// Calc / equational chains (`cite` and `link`): a named ring-identity hold proven by the normalizer is now registered
// as a citable LEMMA (and rewrite rule), so it can be reused via `cite` and chained transitively via `link` -- the same
// as an induction- or kernel-discharged hold. Before, only checkProof- and induction-discharged holds became lemmas, so
// a ring identity could not be cited. Soundness: a `cite` of the wrong identity is still rejected.
// Run: npx tsx test/check/calc-chains.ts

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

// two ring identities, proven as bare holds (so they register as lemmas via the normalizer)
const LEMMAS = `rule assoc-add
  mark a, like integer
  mark b, like integer
  mark c, like integer
  show hold
    call is-equal
      call add
        call add
          read a
          read b
        read c
      call add
        read a
        call add
          read b
          read c

rule reorder
  mark a, like integer
  mark b, like integer
  mark c, like integer
  show hold
    call is-equal
      call add
        read a
        call add
          read b
          read c
      call add
        read a
        call add
          read c
          read b
`

// 1. CITE a ring lemma.
ok(
  'cite a ring identity',
  compiles(`${LEMMAS}
rule cite-assoc
  mark a, like integer
  mark b, like integer
  mark c, like integer
  show hold
    call is-equal
      call add
        call add
          read a
          read b
        read c
      call add
        read a
        call add
          read b
          read c
  cite assoc-add
`),
)

// 2. LINK / calc chain: (a+b)+c == a+(c+b) via assoc then reorder.
ok(
  'link chains two ring lemmas',
  compiles(`${LEMMAS}
rule chain
  mark a, like integer
  mark b, like integer
  mark c, like integer
  show hold
    call is-equal
      call add
        call add
          read a
          read b
        read c
      call add
        read a
        call add
          read c
          read b
  link
    cite assoc-add
    cite reorder
`),
)

// 3. SOUNDNESS CONTROL: citing assoc to prove a non-identity must be rejected.
ok(
  'wrong cite is rejected',
  !compiles(`${LEMMAS}
rule cite-wrong
  mark a, like integer
  mark b, like integer
  mark c, like integer
  show hold
    call is-equal
      call add
        read a
        read b
      call add
        read a
        read c
  cite assoc-add
`),
)

console.log(`\ncalc chains: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
