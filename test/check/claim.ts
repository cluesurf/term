// THE CLAIM WALL. A `rule` states a claim, a `task` of the same name proves it, and between the two the name is
// declared and not defined. Three rules, each with the control that would catch it going silent again:
//
//   1. an unfilled claim is REFUSED, and `note open` leaves it open, counted, and still compiling;
//   2. code that runs may not call a claim nobody filled;
//   3. a hold the prover cannot REACH is an error, not a warning. It was a warning until 2026-09-18, and two
//      plainly false laws compiled clean under it.
//
// Also pinned here: a fill inherits its claim's signature, and the qualified constructor spelling
// (`make equal/refl`) types as the bare one. Both were found by this project and both are load-bearing for it.
//
// Run: npx tsx test/check/claim.ts
// See note/term/project/law-proof-gate.md.

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

type Outcome = {
  refused: boolean
  errors: string[]
  open: string[]
}

function run(text: string): Outcome {
  const result = compile({ file: 'claim.tree', text })

  if (!result.ok) {
    return {
      refused: true,
      errors: result.diagnostics.map(d => d.name ?? ''),
      open: [],
    }
  }

  return {
    refused: false,
    errors: result.warnings.map(d => d.name ?? ''),
    open: result.openClaims ?? [],
  }
}

// ---- 1. an unfilled claim is refused ----

{
  const out = run(`rule double
  take n, like number
  like number
`)

  ok(
    'a claim with no proof is refused',
    out.refused && out.errors.includes('open-claim'),
    out.errors.join(','),
  )
}

{
  const out = run(`rule double
  take n, like number
  like number

task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2
`)

  ok(
    'a claim a task of the same name proves is accepted',
    !out.refused && out.open.length === 0,
    out.errors.join(','),
  )
}

{
  const out = run(`rule double
  note open
  take n, like number
  like number
`)

  ok(
    '`note open` leaves the claim open, counted, and compiling',
    !out.refused && out.open.join(',') === 'double',
    `refused=${out.refused} open=${out.open.join(',')}`,
  )
}

// ---- 2. an open claim cannot be called by code that runs ----

{
  const out = run(`rule double
  note open
  take n, like number
  like number

task use-it
  take n, like number
  like number
  send back
    call double
      read n
`)

  ok(
    'calling an open claim is refused',
    out.refused && out.errors.includes('open-claim-used'),
    out.errors.join(','),
  )
}

{
  const out = run(`rule double
  take n, like number
  like number

task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task use-it
  take n, like number
  like number
  send back
    call double
      read n
`)

  ok(
    'calling a PROVEN claim is fine (the control: the wall is about proof, not about calling)',
    !out.refused,
    out.errors.join(','),
  )
}

{
  const out = run(`rule double
  note open
  take n, like number
  like number

task unrelated
  take double, like number
  like number
  send back
    read double
`)

  ok(
    'CONTROL: a LOCAL that shares an open claim\'s spelling does not trip the wall',
    !out.refused && out.open.join(',') === 'double',
    `refused=${out.refused} ${out.errors.join(',')}`,
  )
}

// ---- 3. not proven is not proven ----

// THE TWO FALSE LAWS THAT USED TO COMPILE. Both are outside the linear fragment, so the prover returns "could
// not reach" rather than "refuted", which was a warning. Neither is true.

{
  const out = run(`rule mul-is-square
  mark a, like number
  mark b, like number
  show
    is-equal
      call multiply
        read a
        read b
      call multiply
        read a
        read a
`)

  ok(
    'a false non-linear law is refused',
    out.refused && out.errors.includes('unchecked-hold'),
    `refused=${out.refused} ${out.errors.join(',')}`,
  )
}

{
  const out = run(`task secret
  take n, like number
  like number
  send back
    call add
      read n
      code 1

rule secret-is-identity
  mark a, like number
  show
    is-equal
      call secret
        read a
      read a
`)

  ok(
    'a false law about a task the prover cannot reach is refused',
    out.refused && out.errors.includes('unchecked-hold'),
    `refused=${out.refused} ${out.errors.join(',')}`,
  )
}

// SOUNDNESS CONTROLS: a TRUE law must still pass, or the change above is just "refuse everything".

{
  const out = run(`rule add-zero
  mark a, like number
  show
    is-equal
      call add
        read a
        code 0
      read a
`)

  ok(
    'a true linear law still passes',
    !out.refused,
    out.errors.join(','),
  )
}

{
  const out = run(`rule mul-comm
  mark a, like number
  mark b, like number
  show
    is-equal
      call multiply
        read a
        read b
      call multiply
        read b
        read a
`)

  ok(
    'a true ring identity still passes (non-linear, discharged by the ring normalizer)',
    !out.refused,
    out.errors.join(','),
  )
}

{
  const out = run(`rule add-one-is-same
  mark a, like number
  show
    is-equal
      call add
        read a
        code 1
      read a
`)

  ok(
    'a false LINEAR law is still refuted by the prover, as before',
    out.refused && out.errors.includes('unproven'),
    out.errors.join(','),
  )
}

// ---- a fill inherits its claim's signature ----

{
  const out = run(`form equal
  head a
  link x, like a
  link y, like a

  case refl
    hold same
      like equal a x x

rule refl
  head a
  take x, like a
  like equal a x x

task refl
  take x
  send back
    make equal/refl
`)

  ok(
    "a fill with no generics, no result and bare parameters inherits the claim's signature",
    !out.refused,
    out.errors.join(','),
  )
}

{
  const out = run(`form equal
  head a
  link x, like a
  link y, like a

  case refl
    hold same
      like equal a x x

rule refl
  head a
  take x, like a
  like equal a x x

task refl
  take x
  send back
    code 1
`)

  ok(
    'CONTROL: a fill whose body does not inhabit the claim is refused',
    out.refused && out.errors.includes('type-mismatch'),
    `refused=${out.refused} ${out.errors.join(',')}`,
  )
}

// ---- the qualified constructor spelling ----

{
  const bare = run(`form light
  case red
  case green

task pick
  like light
  send back
    make red
`)

  const qualified = run(`form light
  case red
  case green

task pick
  like light
  send back
    make light/red
`)

  ok(
    '`make light/red` types as `light`, the same as `make red`',
    !bare.refused && !qualified.refused,
    `bare=${bare.errors.join(',')} qualified=${qualified.errors.join(',')}`,
  )
}

{
  const out = run(`form light
  case red
  case green

form fruit
  case apple

task pick
  like fruit
  send back
    make light/red
`)

  ok(
    'CONTROL: a variant of another enum is still refused',
    out.refused,
    out.errors.join(','),
  )
}

console.log(`\nclaim (the claim wall): ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
