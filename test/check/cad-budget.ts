// THE N-VARIABLE CAD UNDER THE PROOF BUDGET (item term-self-host-001-0057). check/cad-nvar.tree lifts root isolation
// (check/sturm.tree) through a projection whose degree and coefficients grow with every variable: the goal
// `9 + (b c + (d - c)) <= (b^2 d)(b^2 d)` over integer seats asks for the Sturm sequence of a degree-34 product, which
// ran past 20 minutes with nothing to stop it. The lift now pays from the goal's budget and, run out, declines (never
// false, never proven), and the prover goes on to what follows it: here the counterexample search, which finds the goal
// false at zero. A goal the lift can decide is decided as before. Run: npx tsx test/check/cad-budget.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

// holds-pair round 65: b^4 d^2 - b c + c - d - 9 >= 0 is false (b = 0, d = 1), but only the n-variable lift reaches it
const ROUND_65 = `
task sq
  take n, like integer
  like integer

  back multiply(n, n)

rule probe
  seat a, like integer
  seat b, like integer
  seat c, like integer
  seat d, like integer
  show hold
    call is-maximum
      call add
        code 9
        call add
          call multiply
            read b
            read c
          call subtract
            read d
            read c
      call multiply
        call multiply
          call sq
            read b
          read d
        call multiply
          call sq
            read b
          read d
  calm hold
`

// x^2 y^2 + z^2 + 1 > 0 over three integer seats: decided as before, under the default budget
const THREE_SQUARES = `
rule positive
  seat x, like integer
  seat y, like integer
  seat z, like integer
  show hold
    call is-minimum
      call add
        call multiply
          call multiply
            read x
            read x
          call multiply
            read y
            read y
        call multiply
          read z
          read z
      code 0
  calm hold
`

// the Choi-Lam form x^4 y^2 + y^4 z^2 + z^4 x^2 - 3 x^2 y^2 z^2 >= 0: true, not a sum of squares, so only the lift
// reaches it, and its lift costs more than the default budget (test/check/cad-nvar.ts decides it with no budget, in
// minutes). Stopped at the budget, it may still be true: never false
const CHOI_LAM = `
rule choi-lam
  seat x, like integer
  seat y, like integer
  seat z, like integer
  show hold
    call is-minimum
      call add
        call add
          call multiply
            call multiply
              call multiply
                read x
                read x
              call multiply
                read x
                read x
            call multiply
              read y
              read y
          call multiply
            call multiply
              call multiply
                read y
                read y
              call multiply
                read y
                read y
            call multiply
              read z
              read z
        call multiply
          call multiply
            call multiply
              read z
              read z
            call multiply
              read z
              read z
          call multiply
            read x
            read x
      call multiply
        code 3
        call multiply
          call multiply
            read x
            read x
          call multiply
            call multiply
              read y
              read y
            call multiply
              read z
              read z
  calm hold
`

function run(
  source: string,
  budget: string | undefined,
): { ok: boolean; messages: string[]; ms: number } {
  if (budget === undefined) {
    delete process.env.TERM_PROOF_BUDGET
  } else {
    process.env.TERM_PROOF_BUDGET = budget
  }

  const started = Date.now()
  const result = compile({ file: 'cad-budget.tree', text: source })
  const ms = Date.now() - started
  const messages = result.ok
    ? []
    : result.diagnostics.map(d => `${d.name}: ${d.message}`)

  return { ok: result.ok, messages, ms }
}

const stopped = run(ROUND_65, undefined)
ok(
  'round 65 stops at the default budget, in under two minutes',
  !stopped.ok && stopped.ms < 120_000,
  `ok=${stopped.ok} ${stopped.ms} ms`,
)
ok(
  'and the prover goes on past the lift to the counterexample at zero',
  stopped.messages.some(
    m =>
      m.includes('this rule is FALSE') &&
      m.includes('a = 0, b = 0, c = 0, d = 0'),
  ),
  stopped.messages.join(' | ').slice(0, 400),
)

const small = run(ROUND_65, '1000000')
ok(
  'a small budget stops it at once',
  !small.ok && small.ms < 30_000,
  `ok=${small.ok} ${small.ms} ms`,
)

const choiLam = run(CHOI_LAM, undefined)
ok(
  'a true goal whose lift costs more than the budget is stopped at the budget, not refuted',
  !choiLam.ok &&
    choiLam.ms < 120_000 &&
    choiLam.messages.some(m =>
      m.includes('was not proven within the proof budget'),
    ),
  `ok=${choiLam.ok} ${choiLam.ms} ms ${choiLam.messages.join(' | ').slice(0, 400)}`,
)

const decided = run(THREE_SQUARES, undefined)
ok(
  'a three-variable goal the lift can decide is still proven',
  decided.ok,
  decided.messages.join(' | ').slice(0, 400),
)

delete process.env.TERM_PROOF_BUDGET

console.log(`\ncad-budget: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
