// A width is a range (note/term/plan/decisions-2026-10.md, D12). With TERM_WIDTH_RANGES on, a value passed to a
// width-typed parameter, or sent back from a width-typed result, owes `low <= value <= high` as a tier-0 obligation;
// the task may assume it of its parameter, and a call to a width-typed result is known to fit. Off, nothing is owed.
// Run: npx tsx test/check/width-range.ts
//
// Each refusal sits beside the same shape proven, so a prover that proved nothing, or everything, fails here.

import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'
import { setWidthRanges } from '@term/make/code/check/width-range'

let pass = 0
let fail = 0

const stdlib = stdlibResolver()!

// the `width` obligations of the entry file: how many, and how many proven
function expect(name: string, source: string, want: { total: number; proven: number }, ranges = true): void {
  setWidthRanges(ranges)
  const result = compile({ file: 'w.tree', text: source }, { resolve: withNativeEnv('node', stdlib) })
  setWidthRanges(false)

  if (!result.ok) {
    fail++
    console.log(`FAIL  ${name}  (did not compile: ${result.diagnostics.map(d => d.message).join(' | ')})`)

    return
  }

  const got = result.obligations?.kinds?.width ?? { total: 0, proven: 0 }

  if (got.total === want.total && got.proven === want.proven) {
    pass++
    console.log(`ok    ${name}  (${got.proven} of ${got.total})`)
  } else {
    fail++
    const why = (result.obligations?.failed ?? []).filter(f => f.origin === 'width').map(f => f.diagnostic.message)
    console.log(`FAIL  ${name}  (${got.proven} of ${got.total}, wanted ${want.proven} of ${want.total}${why.length ? `: ${why.join(' | ')}` : ''})`)
  }
}

function expectRefused(name: string, source: string, ranges: boolean): void {
  setWidthRanges(ranges)
  const result = compile({ file: 'w.tree', text: source })
  setWidthRanges(false)
  const refusal = result.ok ? undefined : result.diagnostics.find(d => /is outside `u8`/.test(d.message))

  if (refusal) {
    pass++
    console.log(`ok    ${name}  (${refusal.message})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok})`)
  }
}

const PAINT = `task paint
  take level, like u8
  like number
  send back, read level
`

// a task whose whole body is one `send back` is an accessor: what it owes is lifted onto its callers (contract.ts
// `liftedOf`), as a list read is. So each task below that should owe on its own has a statement first
expect(
  'off: a computed argument owes nothing',
  `${PAINT}
task run
  take x, like number
  like number
  save y, read x
  send back
    call paint
      read y
`,
  { total: 0, proven: 0 },
  false,
)

expect(
  'on: an unbounded argument is owed and not proven',
  `${PAINT}
task run
  take x, like number
  like number
  save y, read x
  send back
    call paint
      read y
`,
  { total: 1, proven: 0 },
)

expect(
  "on: an accessor's width is owed by its caller, with the caller's argument, and proven there",
  `${PAINT}
task relay
  take x, like number
  like number
  send back
    call paint
      read x

task run
  like number
  save small, code 9
  send back
    call relay
      read small
`,
  { total: 1, proven: 1 },
)

expect(
  'on: an argument the path bounds is proven',
  `${PAINT}
task run
  take x, like number
  like number
  fork test
    hook test
      call and
        call is-minimum
          read x
          code 0
        call is-maximum
          read x
          code 255
    hook hold
      send back
        call paint
          read x
  send back, code 0
`,
  { total: 1, proven: 1 },
)

expect(
  'on: one bound short is not proven',
  `${PAINT}
task run
  take x, like number
  like number
  fork test
    hook test
      call is-maximum
        read x
        code 255
    hook hold
      send back
        call paint
          read x
  send back, code 0
`,
  { total: 1, proven: 0 },
)

expect(
  'on: a `u8` parameter passed on to a `u8` parameter is proven, by the width it was owed',
  `${PAINT}
task relay
  take level, like u8
  like number
  save same, read level
  send back
    call paint
      read same
`,
  { total: 1, proven: 1 },
)

expect(
  'on: a `u8` plus one is not proven to stay a `u8`',
  `${PAINT}
task brighter
  take level, like u8
  like number
  save next, call add(level, 1)
  send back
    call paint
      read next
`,
  { total: 1, proven: 0 },
)

expect(
  'on: a `u16` parameter does not fit a `u8`',
  `${PAINT}
task narrow
  take level, like u16
  like number
  save same, read level
  send back
    call paint
      read same
`,
  { total: 1, proven: 0 },
)

expect(
  'on: a `u8` result is owed where it is sent back, and proven by the check before it',
  `task clamp
  take x, like number
  like u8
  fork test
    hook test
      call is-below
        read x
        code 0
    hook hold
      send back, code 0
  fork test
    hook test
      call is-above
        read x
        code 255
    hook hold
      send back, code 255
  send back, read x
`,
  { total: 1, proven: 1 },
)

expect(
  'on: a `u8` result sent back unchecked is not proven',
  `task loose
  take x, like number
  like u8
  send back, read x
`,
  { total: 1, proven: 0 },
)

expect(
  "on: a call to a `u8` result fits a `u8` parameter, the result's own obligation paid in its task",
  `${PAINT}
task clamp
  take x, like number
  like u8
  fork test
    hook test
      call is-below
        read x
        code 0
    hook hold
      send back, code 0
  fork test
    hook test
      call is-above
        read x
        code 255
    hook hold
      send back, code 255
  send back, read x

task run
  take x, like number
  like number
  send back
    call paint
      call clamp
        read x
`,
  { total: 2, proven: 2 },
)

expect(
  'on: the stdlib `to-u8` is a checked way in',
  `load @term/base/integer/unsigned
  find to-u8

${PAINT}
task run
  take x, like number
  like number
  send back
    call paint
      call to-u8
        read x
`,
  { total: 1, proven: 1 },
)

expect(
  'on: an `i64` parameter owes nothing, every number is one',
  `task wide
  take n, like i64
  like number
  send back, read n

task run
  take x, like number
  like number
  send back
    call wide
      read x
`,
  { total: 0, proven: 0 },
)

expect(
  'on: a literal argument owes nothing here, the literal check holds it',
  `${PAINT}
task run
  like number
  send back
    call paint
      code 7
`,
  { total: 0, proven: 0 },
)

for (const ranges of [false, true]) {
  expectRefused(
    `${ranges ? 'on' : 'off'}: a literal outside the width is refused`,
    `${PAINT}
task run
  like number
  send back
    call paint
      code 300
`,
    ranges,
  )
}

console.log(`\nwidth-range: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
