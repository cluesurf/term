// No-confusion at depth: an equation between two values is absurd if they are distinct constructors of the same enum,
// OR they share a constructor (or are the same record) but a corresponding FIELD pair is itself absurd. The recursion
// descends through record projections (which now reduce) and enum fields. Soundness is the delicate part: the check
// must fire ONLY on genuine distinct constructors, never on neutral / equal fields, or it would refute a satisfiable
// equation. These tests pin both the positive (deep refutation works) and the negative (no false refutation) sides.
// Run: npx tsx test/check/no-confusion.ts

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

form box
  link tag, like bit
  link rest, like bit

task make-box
  take a, like bit
  take b, like bit
  like box
  send back
    make box
      bind tag, read a
      bind rest, read b
`

// 1. DEEP REFUTATION: two records sharing the `make box` constructor but with distinct `tag` constructors (off vs on)
// are absurd. The `calm miss` must discharge (so the file compiles).
ok(
  'distinct tag field refutes through the record',
  compiles(`${PRELUDE}
rule boxes-with-distinct-tags-differ
  mark b, like bit
  show miss
    call is-equal
      call make-box
        make off
        read b
      call make-box
        make on
        read b
  calm miss
`),
)

// 2. SOUNDNESS CONTROL A: a reflexive record equality must still HOLD (no-confusion must not have made the record
// type inconsistent).
ok(
  'reflexive record equality still holds',
  compiles(`${PRELUDE}
rule same-box-is-equal
  mark a, like bit
  mark b, like bit
  show hold
    call is-equal
      call make-box
        read a
        read b
      call make-box
        read a
        read b
  calm hold
`),
)

// 3. SOUNDNESS CONTROL B: two boxes sharing a tag but with NEUTRAL (variable) rest fields are NOT provably distinct.
// A `calm miss` here must FAIL (the file must NOT compile), or the checker is unsound.
ok(
  'neutral fields are not wrongly refuted',
  !compiles(`${PRELUDE}
rule neutral-rest-boxes-are-not-distinct
  mark a, like bit
  mark b, like bit
  mark c, like bit
  show miss
    call is-equal
      call make-box
        read a
        read b
      call make-box
        read a
        read c
  calm miss
`),
)

console.log(`\nno-confusion at depth: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
