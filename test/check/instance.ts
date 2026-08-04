// Call-site instance resolution: a `need`-bounded generic, called at a concrete type, requires an instance of
// that trait for that type. Run: npx tsx test/check/instance.ts

import { compile } from '@term/make/code/compile/compile'

let pass = 0
let fail = 0

function expectOk(name: string, source: string): void {
  const result = compile({ file: 's.tree', text: source })

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

function expectError(name: string, source: string, code: string): void {
  const result = compile({ file: 's.tree', text: source })

  if (!result.ok && result.diagnostics.some(d => d.name === code)) {
    pass++
    console.log(
      `ok    ${name}  (${
        result.diagnostics.find(d => d.name === code)!.message
      })`,
    )
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (ok=${result.ok}, codes=${
        result.ok ? '' : result.diagnostics.map(d => d.name).join(',')
      })`,
    )
  }
}

const MASK_AND_GENERIC = `mask comparison
  task is-equal
    take self
    take other
    like boolean

task pick
  head t, need comparison
  take item, like t
  like t
  send back item
`

function main(): void {
  // `thing` has a comparison instance, so calling pick at thing resolves
  expectOk(
    'bounded call resolves when instance exists',
    `${MASK_AND_GENERIC}
form thing
  link x, like u64
  wear comparison
    task is-equal
      take self
      send back, true

task run
  take a, like thing
  send back
    call pick
      loan a
`,
  )

  // `other` has NO comparison instance, so calling pick at other is rejected at the call site
  expectError(
    'bounded call rejected when no instance',
    `${MASK_AND_GENERIC}
form other
  link y, like u64

task run
  take b, like other
  send back
    call pick
      loan b
`,
    'no-instance',
  )

  // bound propagation: a bounded generic calling another bounded generic at its own type variable is fine when
  // the enclosing generic carries the same bound
  expectOk(
    'bound propagates through a generic call',
    `${MASK_AND_GENERIC}
task choose
  head u, need comparison
  take a, like u
  like u
  send back
    call pick
      loan a
`,
  )

  // but an unbounded generic cannot satisfy the callee's bound: rejected
  expectError(
    'unbounded generic cannot satisfy a callee bound',
    `${MASK_AND_GENERIC}
task choose
  head u
  take a, like u
  like u
  send back
    call pick
      loan a
`,
    'no-instance',
  )

  console.log(`\ninstance: ${pass} pass, ${fail} fail`)
}

main()
