// Record eta / extensionality (surjective pairing): two values of a record type are equal iff their fields agree. The
// hold-level check (where the goal's type is available, unlike the untyped kernel `convert`) projects each field of both
// sides and compares -- so `x == make pair (x.left) (x.right)` discharges, and any record equality with matching fields.
// Sound: a record is determined by its fields, and a record equality whose fields DIFFER is rejected.
// Run: npx tsx test/check/record-eta.ts

import { compile } from '@cluesurf/make/code/compile/compile'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, detail = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${detail}`)
  }
}

function compiles(source: string): boolean {
  return compile({ file: 'p.tree', text: source }).ok
}

const PRELUDE = `form bit
  case off
  case on

form pair
  link left, like bit
  link right, like bit
`

// 1. ETA: a record equals its own re-bundling from its projections.
ok(
  'record eta: x == make pair (x.left) (x.right)',
  compiles(`${PRELUDE}
rule pair-eta
  mark x, like pair
  show hold
    call is-equal
      read x
      make pair
        bind left
          read x/left
        bind right
          read x/right
  calm hold
`),
)

// 2. SOUNDNESS CONTROL: two pairs differing in a field are NOT equal. Must be rejected.
ok(
  'records differing in a field are not equated',
  !compiles(`${PRELUDE}
rule pair-distinct
  show hold
    call is-equal
      make pair
        bind left
          make off
        bind right
          make on
      make pair
        bind left
          make off
        bind right
          make off
  calm hold
`),
)

console.log(`\nrecord eta: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
