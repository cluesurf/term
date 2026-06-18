// Trait + generics tests: mask/wear/suit instance completeness, trait bounds, and generic functions.
// Run: npx tsx test/check/traits.ts

import { compile } from '@/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string, needle?: string): void {
  const result = compile({ file: 't.tree', text: source })
  if (result.ok && (!needle || result.typescript.includes(needle))) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (${result.ok ? `no "${needle}"` : result.diagnostics.map((d) => d.message).join('; ')})`)
  }
}

function expectError(name: string, source: string, code: string): void {
  const result = compile({ file: 't.tree', text: source })
  if (!result.ok && result.diagnostics.some((d) => d.name === code)) {
    pass++
    console.log(`ok    ${name}  (${result.diagnostics.find((d) => d.name === code)!.message})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, codes=${result.ok ? '' : result.diagnostics.map((d) => d.name).join(',')})`)
  }
}

const COMPARISON = `mask comparison
  task is-equal
    take self
    take other
    like boolean
  task is-not-equal
    take self
    take other
    like boolean
`

function main(): void {
  // a complete instance: the form implements every method of the mask
  expectOk(
    'complete wear instance',
    `${COMPARISON}
form thing
  link x, like u64
  wear comparison
    task is-equal
      take self
      back, wave true
    task is-not-equal
      take self
      back, wave false
`,
    'interface Comparison',
  )

  // an incomplete instance: missing a required method
  expectError(
    'incomplete instance caught',
    `${COMPARISON}
form thing
  link x, like u64
  wear comparison
    task is-equal
      take self
      back, wave true
`,
    'incomplete-instance',
  )

  // an instance of a trait that does not exist
  expectError(
    'instance of unknown trait',
    `form thing
  link x, like u64
  wear nonexistent
    task whatever
      take self
`,
    'unknown-name',
  )

  // a standalone suit implementation, complete
  expectOk(
    'complete suit instance',
    `${COMPARISON}
suit shape
  wear comparison
    task is-equal
      take self
      back, wave true
    task is-not-equal
      take self
      back, wave false
`,
  )

  // a generic function type-checks and emits a type parameter
  expectOk(
    'generic identity',
    `task identity
  head t
  take x, like t
  like t
  back x
`,
    'function identity<T>',
  )

  // a generic with a valid trait bound
  expectOk(
    'generic with valid bound',
    `${COMPARISON}
task sort
  head t, need comparison
  take items
  back items
`,
  )

  // a generic with an unknown trait bound
  expectError(
    'unknown trait bound caught',
    `task sort
  head t, need nonexistent
  take items
  back items
`,
    'unknown-name',
  )

  // coherence: a type may implement a trait only once; an overlapping instance is rejected
  expectError(
    'overlapping instances rejected (coherence)',
    `${COMPARISON}
suit shape
  wear comparison
    task is-equal
      take self
      back, wave true
    task is-not-equal
      take self
      back, wave false
suit shape
  wear comparison
    task is-equal
      take self
      back, wave true
    task is-not-equal
      take self
      back, wave false
`,
    'duplicate-instance',
  )

  console.log(`\ntraits: ${pass} pass, ${fail} fail`)
}

main()
