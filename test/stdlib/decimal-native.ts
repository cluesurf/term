// The exact decimal (deck/base/code/decimal.tree) on every backend: sums that a float gets wrong, and since 2026-10-05
// division and rounding by each of the seven modes, ties and negative quotients included. The decimal built on Swift
// from that day too: the native gate skipped it for a Swift bignum gap that termbig.swift had already closed.
// Run: npx tsx test/stdlib/decimal-native.ts   (DECIMAL_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

// [what is asked, the answer worked by hand]
const CASES: [string, string][] = [
  ['text(decimal-add(make-big-decimal(<0.1>), make-big-decimal(<0.2>)))', '0.3'],
  ['text(decimal-multiply(make-big-decimal(<1.1>), make-big-decimal(<1.1>)))', '1.21'],
  ['text(decimal-subtract(make-big-decimal(<1>), make-big-decimal(<0.9>)))', '0.1'],
  ['text(decimal-divide(make-big-decimal(<1>), make-big-decimal(<3>), 5, make(half-even)))', '0.33333'],
  ['text(decimal-divide(make-big-decimal(<2>), make-big-decimal(<3>), 2, make(half-even)))', '0.67'],
  ['text(decimal-divide(make-big-decimal(<2>), make-big-decimal(<3>), 2, make(down)))', '0.66'],
  ['text(decimal-divide(make-big-decimal(<2>), make-big-decimal(<3>), 2, make(floor)))', '0.66'],
  ['text(decimal-divide(make-big-decimal(<2>), make-big-decimal(<3>), 2, make(ceiling)))', '0.67'],
  ['text(decimal-divide(make-big-decimal(<-2>), make-big-decimal(<3>), 2, make(floor)))', '-0.67'],
  ['text(decimal-divide(make-big-decimal(<-2>), make-big-decimal(<3>), 2, make(ceiling)))', '-0.66'],
  ['text(decimal-divide(make-big-decimal(<-2>), make-big-decimal(<3>), 2, make(up)))', '-0.67'],
  ['text(decimal-divide(make-big-decimal(<10>), make-big-decimal(<4>), 0, make(half-even)))', '2'],
  ['text(decimal-divide(make-big-decimal(<10>), make-big-decimal(<4>), 0, make(half-up)))', '3'],
  ['text(decimal-divide(make-big-decimal(<10>), make-big-decimal(<4>), 0, make(half-down)))', '2'],
  ['text(decimal-divide(make-big-decimal(<14>), make-big-decimal(<4>), 0, make(half-even)))', '4'],
  ['text(decimal-divide(make-big-decimal(<1.5>), make-big-decimal(<0.25>), 3, make(half-even)))', '6.000'],
  ['text(decimal-round(make-big-decimal(<2.345>), 2, make(half-even)))', '2.34'],
  ['text(decimal-round(make-big-decimal(<2.355>), 2, make(half-even)))', '2.36'],
  ['text(decimal-round(make-big-decimal(<2.345>), 2, make(half-up)))', '2.35'],
  ['text(decimal-round(make-big-decimal(<-2.345>), 2, make(half-up)))', '-2.35'],
  ['text(decimal-round(make-big-decimal(<-2.345>), 2, make(half-down)))', '-2.34'],
  ['text(decimal-round(make-big-decimal(<2.3>), 3, make(half-even)))', '2.300'],
  ['text(decimal-divide(make-big-decimal(<123456789012345678901234567890>), make-big-decimal(<7>), 4, make(half-even)))', '17636684144620811271604938270.0000'],
]

const PROGRAM = `load @term/base/decimal
  find big-decimal
  find make-big-decimal
  find decimal-add
  find decimal-subtract
  find decimal-multiply
  find decimal-divide
  find decimal-round
  find rounding

load @term/base/list
  find list
  find join

task by-zero
  like text
  fork
    mark unsafe
    save never, decimal-divide(make-big-decimal(<1>), make-big-decimal(<0>), 2, make(half-even))
    back text(never)
  halt take
    take problem
    back <raised>

task run
  like text
  save out, make list
${CASES.map(([asked]) => `  push(out, ${asked})`).join('\n')}
  push(out, by-zero())
  back join(out, <|>)
`

const EXPECTED = [...CASES.map(([, answer]) => answer), 'raised'].join('|')

const dir = mkdtempSync(join(tmpdir(), 'term-decimal-'))
const only = process.env.DECIMAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'decimal' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  const got = ran.form === 'ran' ? ran.output.split('|') : []
  const want = EXPECTED.split('|')
  const differ = want.flatMap((answer, at) => (got[at] === answer ? [] : [`${CASES[at]?.[0] ?? 'division by zero'}: got ${got[at]}, want ${answer}`]))

  ok(`${backend}: decimal sums, division and rounding answer exactly`, ran.form === 'ran' && differ.length === 0, ran.form === 'ran' ? differ.join(' | ') : `${ran.stage}: ${ran.reason}`)
}

console.log(`\ndecimal-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
