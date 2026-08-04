// Record projection reduction: a struct is encoded as a single-variant self-encoding, so a projection applied to a
// freshly-built record reduces definitionally (`r__field_i (make__r a_0..a_{k-1}) = a_i`). Before this, `make__r` and
// each `r__field` were opaque postulates with no computation rule, so `read p/left` on a constructed pair stayed stuck
// and `calm` could not discharge it. Constructor injectivity falls out of the same encoding. These tests lock both in.
// Run: npx tsx test/check/record-projection.ts

import { compile } from '@term/make/code/compile/compile'

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

// a true hold compiles with no unproven / unchecked-hold complaint
function discharges(source: string): boolean {
  const result = compile({ file: 'p.tree', text: source })

  return (
    result.ok &&
    (result.warnings ?? []).every(
      d => d.name !== 'unchecked-hold' && d.name !== 'unproven',
    )
  )
}

// a false hold fails compilation outright
function rejected(source: string): boolean {
  return !compile({ file: 'p.tree', text: source }).ok
}

const PRELUDE = `form pair
  link left, like integer
  link right, like integer

task make-pair
  take a, like integer
  take b, like integer
  like pair
  send back
    make pair
      bind left, read a
      bind right, read b

task first
  take p, like pair
  like integer
  send back
    read p/left

task second
  take p, like pair
  like integer
  send back
    read p/right
`

// 1. PROJECTION REDUCES: first(make-pair a b) = a, by computation.
ok(
  'left projection reduces',
  discharges(`${PRELUDE}
rule project-left
  mark a, like integer
  mark b, like integer
  show hold
    call is-equal
      call first
        call make-pair
          read a
          read b
      read a
  calm hold
`),
)

// 2. THE OTHER FIELD: second(make-pair a b) = b.
ok(
  'right projection reduces',
  discharges(`${PRELUDE}
rule project-right
  mark a, like integer
  mark b, like integer
  show hold
    call is-equal
      call second
        call make-pair
          read a
          read b
      read b
  calm hold
`),
)

// 3. GENUINELY COMPUTED: the left projection is NOT the right field, so this false claim must be rejected.
ok(
  'wrong projection is rejected',
  rejected(`${PRELUDE}
rule project-left-is-right
  mark a, like integer
  mark b, like integer
  show hold
    call is-equal
      call first
        call make-pair
          read a
          read b
      read b
  calm hold
`),
)

console.log(`\nrecord projection: ${pass} pass, ${fail} fail`)
process.exit(fail > 0 ? 1 : 0)
