// DEFINITIONAL UNFOLDING FOR THE RING PROVER. A task whose whole body is one polynomial over integer parameters may be
// named inside a ring identity, and the prover unfolds it (check/unfold.ts). Each case carries the control that would
// catch the unfolding going unsound: a false identity through the same task must still be refused, a recursive task
// must never be unfolded, and a task over `natural-number` (whose `subtract` truncates) must never be unfolded.
//
// Run: npx tsx test/check/ring-unfold.ts

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

// true when the file compiles with no error
function accepted(text: string): { accepted: boolean; errors: string } {
  const result = compile({ file: 'ring-unfold.tree', text })

  return {
    accepted: result.ok,
    errors: result.ok ? '' : result.diagnostics.map(d => d.name).join(','),
  }
}

// the Eisenstein norm of x + y w, once, as a task
const NORM = `task norm
  take x, like integer
  take y, like integer
  like integer
  send back
    call add
      call subtract
        call multiply
          read x
          read x
        call multiply
          read x
          read y
      call multiply
        read y
        read y
`

// N(a + b w) N(c + d w) = N((ac - bd) + (ad + bc - bd) w), with the omega coordinate's middle sign given
function multiplicative(sign: 'subtract' | 'add'): string {
  return `${NORM}
rule norm-is-multiplicative
  mark a, like integer
  mark b, like integer
  mark c, like integer
  mark d, like integer
  show hold
    call is-equal
      call multiply
        call norm
          read a
          read b
        call norm
          read c
          read d
      call norm
        call subtract
          call multiply
            read a
            read c
          call multiply
            read b
            read d
        call ${sign}
          call add
            call multiply
              read a
              read d
            call multiply
              read b
              read c
          call multiply
            read b
            read d
`
}

{
  const out = accepted(multiplicative('subtract'))
  ok('a ring identity through a named task is proved', out.accepted, out.errors)
}

{
  const out = accepted(multiplicative('add'))
  ok('a false identity through the same task is refused', !out.accepted, out.errors)
}

// nested: a task that calls another unfoldable task
{
  const out = accepted(`${NORM}
task double-norm
  take x, like integer
  take y, like integer
  like integer
  send back
    call add
      call norm
        read x
        read y
      call norm
        read x
        read y

rule double-norm-is-twice
  mark a, like integer
  mark b, like integer
  show hold
    call is-equal
      call double-norm
        read a
        read b
      call multiply
        code 2
        call norm
          read a
          read b
`)
  ok('a task calling a task unfolds through both', out.accepted, out.errors)
}

// a recursive task is never unfolded, so a goal that needs its unfolding stays unproved
{
  const out = accepted(`task loop
  take x, like integer
  like integer
  send back
    call add
      call loop
        read x
      code 0

rule loop-is-itself
  mark a, like integer
  show hold
    call is-equal
      call loop
        read a
      call add
        call loop
          read a
        code 1
`)
  ok('a recursive task is not unfolded', !out.accepted, out.errors)
}

// a natural-number task is never unfolded: monus(a, b) + b == a is false at a = 0, b = 1
{
  const out = accepted(`task monus
  take x, like natural-number
  take y, like natural-number
  like natural-number
  send back
    call subtract
      read x
      read y

rule monus-then-add-returns
  mark a, like natural-number
  mark b, like natural-number
  show hold
    call is-equal
      call add
        call monus
          read a
          read b
        read b
      read a
`)
  ok('a task over natural-number is not unfolded', !out.accepted, out.errors)
}

// a named task inside a `have` is unfolded too: a unit boost (d^2 - n^2 = 1) keeps the interval t^2 - x^2
const INTERVAL = `task interval
  take t, like integer
  take x, like integer
  like integer
  send back
    call subtract
      call multiply
        read t
        read t
      call multiply
        read x
        read x
`

function unitBoost(premise: string): string {
  return `${INTERVAL}
rule a-unit-boost-keeps-the-interval
  mark d, like integer
  mark n, like integer
  mark t, like integer
  mark x, like integer
  have unit
    call is-equal
      call interval
        read d
        read n
      code ${premise}
  show hold
    call is-equal
      call interval
        call add
          call multiply
            read d
            read t
          call multiply
            read n
            read x
        call add
          call multiply
            read n
            read t
          call multiply
            read d
            read x
      call interval
        read t
        read x
`
}

{
  const out = accepted(unitBoost('1'))
  ok('a named task in a hypothesis is unfolded', out.accepted, out.errors)
}

{
  const out = accepted(unitBoost('2'))
  ok('the same identity under a false premise for it is refused', !out.accepted, out.errors)
}

console.log(`\n${pass} passed, ${fail} failed`)

if (fail > 0) {
  process.exit(1)
}
