// Multi-index inversion (no-confusion across EVERY index position). A value-indexed family may carry several indices
// (`lt a b`, the proof that a < b, is indexed by both a and b). When a match's subject pins an index to a constructor
// (`lt m zero`), every variant whose OUTPUT index at that position has a different head is impossible there, so the
// match may omit it -- and a match where ALL variants are impossible is vacuously exhaustive (ex-falso: from `lt m zero`
// you may produce anything, since nothing is below zero). The earlier inversion only inspected the FIRST index; this
// checks that the relaxation now ranges over all positions, while still REQUIRING reachable branches (soundness).
// Run: npx tsx test/check/inversion-multi.ts

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

// nat and the two-index `lt a b` (a < b): `ltself : lt q (succ q)` and `ltmore : lt x y -> lt x (succ y)`. Both
// constructors' SECOND index is headed by `succ`, so `lt _ zero` is uninhabited.
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
`

// 1. ex-falso: a match on `lt m zero` with NO branches is accepted, because the impossible head is on the SECOND index
// (the single-index relaxation would have missed it and demanded the cases).
ok(
  'empty match on lt m zero is vacuously exhaustive (ex-falso on the second index)',
  compiles(`${PRELUDE}
task absurd-below-zero
  take m, like nat
  take pf, like lt
    head
      read m
    head
      make zero
  like nat
  fork case, read pf
`),
)

// 2. SOUNDNESS CONTROL: when the subject index is NOT pinned to a constructor (`lt a b`, both indices variable), no
// variant is impossible, so an empty / partial match must be REJECTED as non-exhaustive.
ok(
  'unconstrained lt a b still requires its branches (no spurious exclusion)',
  !compiles(`${PRELUDE}
task bad-open-match
  take a, like nat
  take b, like nat
  take pf, like lt
    head
      read a
    head
      read b
  like nat
  fork case, read pf
`),
)

// 3. SOUNDNESS CONTROL: at `lt m (succ zero)` BOTH constructors are reachable (their second index is `succ ..`), so an
// empty match must be rejected -- the relaxation must not exclude a genuinely reachable variant.
ok(
  'lt m (succ zero) keeps its reachable branches (empty match rejected)',
  !compiles(`${PRELUDE}
task bad-succ-match
  take m, like nat
  take pf, like lt
    head
      read m
    head
      make succ
        bind prior
          make zero
  like nat
  fork case, read pf
`),
)

// the kernel COMPUTES through a multi-index inversion, not only type-checks it. `pickb a b` has `pzero : pickb a zero`
// and `psucc : pickb a (succ y)`; at `pickb a zero` the `psucc` branch is impossible (second index `succ` != `zero`),
// so a match may omit it AND the eliminator reduces to the reachable `pzero` branch. This needs the kernel discriminator
// motive to discriminate on the SECOND index. (The earlier inversion only handled the first index.)
const PICKB = `form nat
  case zero
  case succ
    link prior, like nat

form pickb
  head a, like nat
  head b, like nat
  case pzero
    link va, like nat
    head
      read va
    head
      make zero
  case psucc
    link wa, like nat
    link wb, like nat
    head
      read wa
    head
      make succ
        bind prior
          read wb

task get
  take a, like nat
  take p
    like pickb
      head
        read a
      head
        make zero
  like nat
  fork case, read p
    case pzero
      link va
      send back
        read va
`

// 4. the reachable branch COMPUTES with the impossible one omitted: get 0 (pzero 0) == 0.
ok(
  'multi-index inversion COMPUTES the reachable branch: get 0 (pzero 0) == 0',
  compiles(`${PICKB}
rule get-ok
  show hold
    call is-equal
      call get
        make zero
        make pzero
          bind va
            make zero
      make zero
  calm hold
`),
)

// 5. SOUNDNESS CONTROL: get 0 (pzero 0) is 0, not 1. The inverted match must compute the RIGHT value.
ok(
  'wrong value through a multi-index inversion is rejected (get 0 (pzero 0) != 1)',
  !compiles(`${PICKB}
rule get-wrong
  show hold
    call is-equal
      call get
        make zero
        make pzero
          bind va
            make zero
      make succ
        bind prior
          make zero
  calm hold
`),
)

console.log(`\ninversion-multi: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
