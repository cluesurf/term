// A rule that does not hold says what it was asked, and, when small values of its marks satisfy its hypotheses and
// break its goal, that it is FALSE there (check/explain.ts). The search only evaluates, so it can never prove anything:
// these cases hold it to saying FALSE only where the values really do break the rule, and to staying silent otherwise.
// Run: npx tsx test/check/explain.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function said(text: string): string[] {
  const result = compile({ file: 'x.tree', text })

  return result.ok ? [] : result.diagnostics.map(d => `${d.name}: ${d.message}`)
}

function ok(name: string, good: boolean, detail: string[]): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n      ${detail.join('\n      ')}`)
  }
}

{
  const out = said(`rule doubling-is-adding-one
  mark n, like integer
  show hold, is-equal multiply(2, n), add(n, 1)
`)

  ok(
    'a false law names the values that break it, and its goal',
    out.some(m => m.includes('This rule is FALSE: at n = 0 the goal does not hold (goal: 2 * n == n + 1)') || m.includes('this rule is FALSE: at n = 0 the goal does not hold (goal: 2 * n == n + 1)')),
    out,
  )
}

{
  const out = said(`rule square-at-least-double
  mark n, like integer
  have n-is-at-least-one, is-minimum n, 1
  show hold, is-minimum multiply(n, n), multiply(2, n)
`)

  ok(
    'and its hypotheses, which hold at those values',
    out.some(m => m.includes('FALSE: at n = 1 every hypothesis holds and the goal does not (goal: n * n >= 2 * n, given: n >= 1)')),
    out,
  )
}

{
  const out = said(`rule square-at-least-double
  mark n, like integer
  have n-is-at-least-two, is-minimum n, 2
  show hold, is-minimum multiply(n, n), multiply(2, n)
`)

  ok('control: a true law is proven, and nothing is said', out.length === 0, out)
}

// false, but only past the values searched: no FALSE, the ordinary message, with the goal and hypothesis printed
{
  const out = said(`rule bounded-square
  mark n, like integer
  have n-is-at-least-ten, is-minimum n, 10
  show hold, is-maximum multiply(n, n), 100
`)

  ok(
    'a law false only past the values searched is not called false, and is still refused',
    out.length > 0 && !out.some(m => /FALSE/.test(m)) && out.some(m => m.includes('(goal: n * n <= 100, given: n >= 10)')),
    out,
  )
}

// a goal that calls a task whose body is one `back <expression>` is run with that task
{
  const out = said(`task double
  take n, like integer

  like integer

  back multiply(n, 2)

rule double-is-one-more
  mark n, like integer
  show is-equal double(n), add(n, 1)
`)

  ok(
    'a goal that calls a one-expression task runs it: double(n) == n + 1 is false at n = 0',
    out.some(m => m.includes('FALSE: at n = 0 the goal does not hold (goal: double(n) == n + 1)')),
    out,
  )
}

// a mark that is a FUNCTION has no small values to try: described, never called false
{
  const out = said(`rule function-mark
  mark x
    like task
      take n, like integer
      like integer
  mark n, like integer
  show hold, is-minimum x(n), 0
`)

  ok('a rule over a function mark is described, never called false', out.length > 0 && !out.some(m => /FALSE/.test(m)), out)
}

console.log(`\nexplain: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
