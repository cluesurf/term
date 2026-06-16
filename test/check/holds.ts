// End-to-end hold-checking: a `hold` clause proven (or not) from parameter refinements via the prover.
// Run: npx tsx test/check/holds.ts

import { compile } from '@/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string): void {
  const result = compile({ file: 'h.tree', text: source })
  if (result.ok) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (${result.diagnostics.map((d) => d.message).join('; ')})`)
  }
}

function expectUnproven(name: string, source: string): void {
  const result = compile({ file: 'h.tree', text: source })
  if (!result.ok && result.diagnostics.some((d) => d.name === 'unproven')) {
    pass++
    console.log(`ok    ${name}  (${result.diagnostics[0]!.message})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, codes=${result.ok ? '' : result.diagnostics.map((d) => d.name).join(',')})`)
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
      mark 0
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
      mark 0
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
        mark 1
      mark 0
`,
  )

  // a hold that is just false (0 >= 1) is unproven with no assumptions
  expectUnproven(
    'false hold rejected',
    `task bad
  take n
  hold
    call is-minimum
      mark 0
      mark 1
`,
  )

  console.log(`\nholds: ${pass} pass, ${fail} fail`)
}

main()
