// End-to-end hold-checking: a `hold` clause proven (or not) from parameter refinements via the prover.
// Run: npx tsx test/check/holds.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string): void {
  const result = compile({ file: 'h.tree', text: source })
  if (result.ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (${result.diagnostics
        .map(d => d.message)
        .join('; ')})`,
    )
  }
}

function expectUnproven(name: string, source: string): void {
  const result = compile({ file: 'h.tree', text: source })
  if (
    !result.ok &&
    result.diagnostics.some(d => d.name === 'unproven')
  ) {
    pass++
    console.log(`ok    ${name}  (${result.diagnostics[0]!.message})`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, codes=${
        result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
      })`,
    )
  }
}

function expectWarning(
  name: string,
  source: string,
  code: string,
): void {
  const result = compile({ file: 'h.tree', text: source })
  const warnings = result.ok ? result.warnings : []
  if (result.ok && warnings.some(d => d.name === code)) {
    pass++
    console.log(
      `ok    ${name}  (${
        warnings.find(d => d.name === code)!.message
      })`,
    )
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, warnings=${warnings
        .map(d => d.name)
        .join(',')})`,
    )
  }
}

function expectDischarged(name: string, source: string): void {
  const result = compile({ file: 'h.tree', text: source })
  const warnings = result.ok ? result.warnings : []
  if (result.ok && !warnings.some(d => d.name === 'unchecked-hold')) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, warnings=${warnings
        .map(d => d.name)
        .join(',')})`,
    )
  }
}

function main(): void {
  // a natural-number parameter gives the assumption n >= 0; the hold n >= 0 is provable
  expectOk(
    'natural => n >= 0 holds',
    `task safe
  take n, like natural-number
  hold
    call is-minimum
      loan n
      code 0
`,
  )

  // n >= 0 does NOT prove n > 0 (n could be 0): the hold is unproven
  expectUnproven(
    'natural =/=> n > 0',
    `task risky
  take n, like natural-number
  hold
    call is-above
      loan n
      code 0
`,
  )

  // with n >= 0, the hold n + 1 > 0 is provable
  expectOk(
    'natural => n + 1 > 0 holds',
    `task safe
  take n, like natural-number
  hold
    call is-above
      call add
        loan n
        code 1
      code 0
`,
  )

  // a hold that is just false (0 >= 1) is unproven with no assumptions
  expectUnproven(
    'false hold rejected',
    `task bad
  take n
  hold
    call is-minimum
      code 0
      code 1
`,
  )

  // a branch condition refines its body: inside `if n >= 5`, the hold n >= 0 is provable
  expectOk(
    'branch condition is assumed inside the branch',
    `task guarded
  take n
  fork test
    hook test
      call is-minimum
        loan n
        code 5
    hook hold
      hold
        call is-minimum
          loan n
          code 0
`,
  )

  // the else branch assumes the negation: inside the miss of `if n >= 5`, n < 5 is provable
  expectOk(
    'else branch assumes the negated condition',
    `task guarded-else
  take n
  fork test
    hook test
      call is-minimum
        loan n
        code 5
    hook hold
      hold
        call is-minimum
          loan n
          code 0
    hook miss
      hold
        call is-below
          loan n
          code 5
`,
  )

  // an immutable binding propagates its defining equality: host m = n + 1 with n >= 0 proves m >= 1
  expectOk(
    'immutable binding propagates an equality',
    `task bound
  take n, like natural-number
  host m
    call add
      loan n
      code 1
  hold
    call is-minimum
      loan m
      code 1
`,
  )

  // a reassignable binding does NOT propagate (its value can change): m >= 1 is unproven
  expectUnproven(
    'mutable binding does not propagate',
    `task unbound
  take n, like natural-number
  save m
    call add
      loan n
      code 1
  hold
    call is-minimum
      loan m
      code 1
`,
  )

  // mod reasoning: n mod 3 is known to be in [0, 2], so n mod 3 < 3 is provable
  expectOk(
    'mod result is bounded (n mod 3 < 3)',
    `task wrap
  take n
  hold
    call is-below
      call modulo
        loan n
        code 3
      code 3
`,
  )

  // and the lower bound: n mod 3 >= 0
  expectOk(
    'mod result is non-negative (n mod 3 >= 0)',
    `task wrap
  take n
  hold
    call is-minimum
      call modulo
        loan n
        code 3
      code 0
`,
  )

  // kernel fallback: a non-linear equality hold is discharged by the kernel's definitional equality
  expectDischarged(
    'reflexive non-linear hold discharged by the kernel',
    `task check-it
  take n
  hold
    call is-equal
      call multiply
        loan n
        loan n
      call multiply
        loan n
        loan n
  send back n
`,
  )

  // and via delta: a transparent function call equals its unfolding, so the kernel proves the equality
  expectDischarged(
    'definitional hold discharged via a transparent function (delta)',
    `task double
  take n, like number
  like number
  send back
    call add
      loan n
      loan n

task check-it
  take n, like number
  like number
  hold
    call is-equal
      call double
        loan n
      call add
        loan n
        loan n
  send back n
`,
  )

  // a non-linear hold (multiplication) is outside the fragment: a warning, not a false pass and not a hard error
  expectWarning(
    'non-linear hold is flagged, not silently skipped',
    `task nonlinear
  take n
  hold
    call is-minimum
      call multiply
        loan n
        loan n
      code 0
`,
    'unchecked-hold',
  )

  console.log(`\nholds: ${pass} pass, ${fail} fail`)
}

main()
