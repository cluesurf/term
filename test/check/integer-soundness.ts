// Integer-literal soundness: each distinct numeric literal is its OWN postulated kernel constant, so the kernel can tell
// `24` from `999`. Before this, every integer collapsed to one `numberValue`, making any two literals definitionally
// equal. A false equality slipped through whenever the closed-arithmetic linear prover did not also cover the goal: a
// non-linear TASK CALL that the kernel reduces to a literal (e.g. `order(tee) == 999` where `order(tee) = 24`) was
// wrongly discharged. These tests lock the gap shut: true integer equalities still discharge, false ones are rejected.
// Run: npx tsx test/check/integer-soundness.ts

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

// a hold with no working proof must fail compilation outright (an unproven hold is an error, not a warning)
function rejected(source: string): boolean {
  return !compile({ file: 'p.tree', text: source }).ok
}

// a true hold compiles with no unproven / unchecked-hold complaint
function discharges(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  return (
    result.ok &&
    (result.warnings ?? []).every(
      d => d.name !== 'unchecked-hold' && d.name !== 'unproven',
    )
  )
}

// a task that returns a concrete integer, so a hold can compare its reduced result against a literal
const PRELUDE = `form kind
  case tee

task order
  take k, like kind
  like integer
  fork case, read k
    case tee
      send back
        code 24
`

function hold(name: string, left: string, right: string): string {
  return `${PRELUDE}
hold ${name}
  call is-equal
${left}
${right}
`
}

const LIT24 = '    code 24'
const LIT999 = '    code 999'
const LIT120 = '    code 120'
const ORDER_TEE = `    call order
      make tee`
const MUL_60_2 = `    call multiply
      code 60
      code 2`

// 1. DIRECT literals: equal passes, unequal is rejected.
ok('direct 120 == 120 discharges', discharges(hold('a', LIT120, LIT120)))
ok('direct 120 == 999 is rejected', rejected(hold('b', LIT120, LIT999)))

// 2. CLOSED ARITHMETIC: a true product passes (via the linear prover), a false one is rejected.
ok('product 120 == 60*2 discharges', discharges(hold('c', LIT120, MUL_60_2)))
ok('product 999 == 60*2 is rejected', rejected(hold('d', LIT999, MUL_60_2)))

// 3. THE KEY REGRESSION: a task call the kernel reduces to 24. True passes, false is rejected — the kernel can no longer
// treat 24 and 999 as convertible, and the non-linear task call means the linear prover never even sees it.
ok('task order(tee) == 24 discharges', discharges(hold('e', ORDER_TEE, LIT24)))
ok('task order(tee) == 999 is rejected', rejected(hold('f', ORDER_TEE, LIT999)))

console.log(`\ninteger soundness: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
