// THE PROOF BUDGET (check/product.ts, check/holds.ts): the exact search's work per goal is capped, deterministically,
// so a refusal stops instead of searching for half an hour. Spending it may only DECLINE: a goal it stops is reported as
// stopped (it may still be true), never as false, and never proven.
// Run: npx tsx test/check/budget.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expect(name: string, source: string, budget: string | undefined, want: string): void {
  if (budget === undefined) {
    delete process.env.TERM_PROOF_BUDGET
  } else {
    process.env.TERM_PROOF_BUDGET = budget
  }

  const result = compile({ file: 'b.tree', text: source })
  const messages = result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)
  const good = want === 'ok' ? result.ok : !result.ok && messages.some(m => m.includes(want))

  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, wanted ${want})\n      ${messages.join('\n      ')}`)
  }
}

// a >= 2 gives a * a >= 2 a: a product of facts, so the exact search must run
const SQUARE = `
rule square-bound
  mark a, like integer
  have a-is-at-least-two
    call is-minimum
      read a
      code 2
  show hold
    call is-minimum
      call multiply
        read a
        read a
      call multiply
        code 2
        read a
`

// a >= 2 gives a + 1 >= 3: the linear prover's, with no exact search at all
const LINEAR = `
rule shifted-bound
  mark a, like integer
  have a-is-at-least-two
    call is-minimum
      read a
      code 2
  show hold
    call is-minimum
      call add
        read a
        code 1
      code 3
`

expect('the default budget proves a product goal', SQUARE, undefined, 'ok')
expect(
  'a budget too small for it STOPS the search, and says so: not false, not proven',
  SQUARE,
  '10',
  'was not proven within the proof budget (10 units of exact search)',
)
expect('a goal the linear prover closes needs no budget', LINEAR, '10', 'ok')
expect('and the budget is per run: unset, the product goal is proven again', SQUARE, undefined, 'ok')

delete process.env.TERM_PROOF_BUDGET

console.log(`\nbudget: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
