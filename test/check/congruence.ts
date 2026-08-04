// Term-level congruence closure under hypotheses: `convertMod` recurses structurally (giving congruence, `x = y` implies
// `f x = f y`) and `matchesHypothesis` now closes the hypothesis equalities transitively (`x = y` and `y = z` give
// `x = z`). Together these decide ground equality modulo a set of equational `have` hypotheses. The soundness control is
// essential: two UNRELATED hypotheses must not connect their endpoints, or the prover would equate distinct things.
// Run: npx tsx test/check/congruence.ts

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

const PRELUDE = `form thing
  case a
  case b
  case c
  case d

task wrap
  take x, like thing
  like thing
  fork case, read x
    case a
      send back
        make b
    case b
      send back
        make c
    case c
      send back
        make d
    case d
      send back
        make a
`

// 1. TRANSITIVITY: x = y and y = z give x = z.
ok(
  'transitive chain closes',
  compiles(`${PRELUDE}
rule transitive-chain
  mark x, like thing
  mark y, like thing
  mark z, like thing
  have h1
    call is-equal
      read x
      read y
  have h2
    call is-equal
      read y
      read z
  show hold
    call is-equal
      read x
      read z
  calm hold
`),
)

// 2. CONGRUENCE: x = y gives wrap x = wrap y.
ok(
  'congruence under a function',
  compiles(`${PRELUDE}
rule congruence-step
  mark x, like thing
  mark y, like thing
  have h
    call is-equal
      read x
      read y
  show hold
    call is-equal
      call wrap
        read x
      call wrap
        read y
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: x = y and z = w (disjoint) do NOT give x = z. Must be rejected.
ok(
  'unrelated hypotheses do not connect',
  !compiles(`${PRELUDE}
rule unrelated-hypotheses-do-not-connect
  mark x, like thing
  mark y, like thing
  mark z, like thing
  mark w, like thing
  have h1
    call is-equal
      read x
      read y
  have h2
    call is-equal
      read z
      read w
  show hold
    call is-equal
      read x
      read z
  calm hold
`),
)

console.log(`\ncongruence closure: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
