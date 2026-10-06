// Trait + generics tests: mask/wear/suit instance completeness, the signature each worn task must fit, coherence, trait
// bounds, and generic functions.
// Run: npx tsx test/check/traits.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string, needle?: string): void {
  const result = compile({ file: 't.tree', text: source })

  if (result.ok && (!needle || result.typescript.includes(needle))) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (${
        result.ok
          ? `no "${needle}"`
          : result.diagnostics.map(d => d.message).join('; ')
      })`,
    )
  }
}

// refused with this code, and, when given, a message holding `needle`
function expectError(name: string, source: string, code: string, needle?: string): void {
  const result = compile({ file: 't.tree', text: source })
  const found = result.ok ? undefined : result.diagnostics.find(d => d.name === code && (!needle || d.message.includes(needle)))

  if (found) {
    pass++
    console.log(`ok    ${name}  (${found.message})`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, ${
        result.ok ? '' : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')
      })`,
    )
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

// the two tasks as the mask declares them, for a form to wear
const WORN = `  wear comparison
    task is-equal
      take self
      take other
      send back, true
    task is-not-equal
      take self
      take other
      send back, false
`

function main(): void {
  // a complete instance: the form implements every method of the mask
  expectOk(
    'complete wear instance',
    `${COMPARISON}
form thing
  link x, like u64
${WORN}`,
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
      take other
      send back, true
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

  // a standalone suit implementation, complete, for a form declared apart from it
  expectOk(
    'complete suit instance',
    `${COMPARISON}
form shape
  link sides, like number

suit shape
${WORN}`,
  )

  // a suit for a form the build does not have
  expectError(
    'suit for no form refused',
    `${COMPARISON}
suit shape
${WORN}`,
    'unknown-name',
    '`suit shape` wears "comparison" for the form "shape", which this build does not have',
  )

  // THE SIGNATURE A WORN TASK MUST FIT, which the mask declares: as many inputs, self first, each of the declared types,
  // and the declared result. Masks kept their tasks' names alone until 2026-10-05, and each of these built
  expectError(
    'a worn task with too few inputs is refused',
    `${COMPARISON}
form thing
  link x, like u64
  wear comparison
    task is-equal
      take self
      send back, true
    task is-not-equal
      take self
      take other
      send back, false
`,
    'type-mismatch',
    'whose "is-equal" takes 2 inputs, self first, and this "is-equal" takes 1',
  )

  expectError(
    'a worn task with too many inputs is refused',
    `${COMPARISON}
form thing
  link x, like u64
  wear comparison
    task is-equal
      take self
      take other
      take third
      send back, true
    task is-not-equal
      take self
      take other
      send back, false
`,
    'type-mismatch',
    'takes 2 inputs, self first, and this "is-equal" takes 3',
  )

  expectError(
    'a worn task answering the wrong type is refused',
    `mask scorer
  task score
    take self
    like number

form player
  link name, like text
  wear scorer
    task score
      take self
      like text
      back self/name
`,
    'type-mismatch',
    'whose "score" answers number, and this one answers text',
  )

  expectError(
    'a worn task taking the wrong type is refused',
    `mask sizer
  task scale
    take self
    take by, like number
    like number

form box
  link side, like number
  wear sizer
    task scale
      take self
      take by, like text
      like number
      back self/side
`,
    'type-mismatch',
    'whose "scale" takes number as "by", and this one takes text',
  )

  // a worn task that leaves a type off takes the mask's: `by` is a number, so a text there is refused at the call
  expectError(
    'a worn task with no types takes the mask\'s',
    `mask sizer
  task scale
    take self
    take by, like number
    like number

form box
  link side, like number
  wear sizer
    task scale
      take self
      take by
      back multiply(self/side, by)

task use
  like number
  save b, make box, bind side, 2
  back scale(b, <three>)
`,
    'type-mismatch',
  )

  // a generic function type-checks and emits a type parameter
  expectOk(
    'generic identity',
    `task identity
  head t
  take x, like t
  like t
  send back x
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
  send back items
`,
  )

  // a generic with an unknown trait bound
  expectError(
    'unknown trait bound caught',
    `task sort
  head t, need nonexistent
  take items
  send back items
`,
    'unknown-name',
  )

  // coherence: a type may implement a trait only once; an overlapping instance is rejected
  expectError(
    'overlapping instances rejected (coherence)',
    `${COMPARISON}
form shape
  link sides, like number

suit shape
${WORN}
suit shape
${WORN}`,
    'duplicate-instance',
  )

  // and a form that wears a mask and is also suited to it
  expectError(
    'a wear and a suit of one mask rejected (coherence)',
    `${COMPARISON}
form shape
  link sides, like number
${WORN}
suit shape
${WORN}`,
    'duplicate-instance',
  )

  console.log(`\ntraits: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exit(1)
  }
}

main()
