// Proof by reflection (`decide`): a decidable proposition is proven by COMPUTING its decision procedure to the expected
// result. `calm` already provides this -- it runs the transparent decision function and checks the normal form -- so a
// goal `decide args == verdict` discharges when the procedure computes that verdict, and is rejected otherwise. This is
// the reflection technique (run a verified decider, trust its output) generalizing what `calm` does for equalities.
// Run: npx tsx test/check/reflection.ts

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

// a three-valued colour and a DECISION PROCEDURE `same` returning a yes/no verdict
const PRELUDE = `form colour
  case red
  case green
  case blue

form verdict
  case yes
  case no

task same
  take x, like colour
  take y, like colour
  like verdict
  fork case, read x
    case red
      fork case, read y
        case red
          send back
            make yes
        case green
          send back
            make no
        case blue
          send back
            make no
    case green
      fork case, read y
        case red
          send back
            make no
        case green
          send back
            make yes
        case blue
          send back
            make no
    case blue
      fork case, read y
        case red
          send back
            make no
        case green
          send back
            make no
        case blue
          send back
            make yes
`

// 1. reflection: same(red, red) computes to yes.
ok(
  'decider computes the true verdict',
  compiles(`${PRELUDE}
rule red-is-red
  show hold
    call is-equal
      call same
        make red
        make red
      make yes
  calm hold
`),
)

// 2. reflection: same(red, blue) computes to no.
ok(
  'decider computes the false verdict',
  compiles(`${PRELUDE}
rule red-not-blue
  show hold
    call is-equal
      call same
        make red
        make blue
      make no
  calm hold
`),
)

// 3. SOUNDNESS CONTROL: same(red, blue) is NOT yes. Must be rejected.
ok(
  'wrong verdict is rejected',
  !compiles(`${PRELUDE}
rule red-blue-wrong
  show hold
    call is-equal
      call same
        make red
        make blue
      make yes
  calm hold
`),
)

console.log(`\nreflection: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
