// Boolean-connective goals: `meet and` (conjunction) is discharged by proving BOTH operands, `meet or` (disjunction) by
// proving ONE, recursively, with equality leaves settled by convertibility or the ring normalizer. No new surface
// syntax (`meet` already existed). Soundness: a conjunction with a false conjunct must NOT be discharged.
// Run: npx tsx test/check/connective-goals.ts

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

// a true rule goal compiles clean with no unproven warning; a false one leaves an unproven hold (or errors)
function discharges(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  return (
    result.ok &&
    (result.warnings ?? []).every(
      d => d.name !== 'unchecked-hold' && d.name !== 'unproven',
    )
  )
}

const PRELUDE = `form thing
  case a
  case b
`

function goal(connective: string, leftEq: [string, string], rightEq: [string, string]): string {
  return `${PRELUDE}
rule connective-goal
  show hold
    meet ${connective}
      call is-equal
        make ${leftEq[0]}
        make ${leftEq[1]}
      call is-equal
        make ${rightEq[0]}
        make ${rightEq[1]}
  calm hold
`
}

// conjunction: both conjuncts true -> discharges
ok('conjunction of two truths discharges', discharges(goal('and', ['a', 'a'], ['b', 'b'])))

// disjunction: only the right disjunct true -> discharges
ok('disjunction with one true disjunct discharges', discharges(goal('or', ['a', 'b'], ['a', 'a'])))

// SOUNDNESS: conjunction with a false conjunct must NOT discharge
ok(
  'conjunction with a false conjunct does not discharge',
  !discharges(goal('and', ['a', 'a'], ['a', 'b'])),
)

console.log(`\nconnective goals: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
