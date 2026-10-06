// The exact rational (deck/base/code/rational.tree), on big integers since 2026-10-05, on every backend: the sums and
// products a fraction is for, and terms past the edge of a whole number, which stopped the program while they were
// `number`s. The answers past i64 are worked here by BigInt.
// Run: npx tsx test/stdlib/rational-native.ts   (RATIONAL_ONLY=typescript, rust, swift or kotlin runs one)

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

const BIG = 4611686018427387903n // 2^62 - 1

// the reduced text of n/d, by BigInt
function fraction(n: bigint, d: bigint): string {
  const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? (a < 0n ? -a : a) : gcd(b, a % b))
  const g = gcd(n, d)
  let top = n / g
  let bottom = d / g

  if (bottom < 0n) {
    top = -top
    bottom = -bottom
  }

  return bottom === 1n ? `${top}` : `${top}/${bottom}`
}

const CASES: [string, string][] = [
  ['rational-text(add(make-rational(1, 2), make-rational(1, 3)))', '5/6'],
  ['rational-text(subtract(make-rational(1, 3), make-rational(1, 2)))', '-1/6'],
  ['rational-text(divide(make-rational(3, 4), make-rational(-9, 8)))', '-2/3'],
  ['rational-text(make-rational(10, -4))', '-5/2'],
  // past 2^53 a whole number is written as a big integer, from its text: a `number` literal that large is not exact on
  // TypeScript, whose number is a double
  [`rational-text(multiply(big(<${BIG}>, <3>), big(<${BIG}>, <5>)))`, fraction(BIG * BIG, 15n)],
  [`rational-text(add(big(<${BIG}>, <7>), big(<${BIG}>, <11>)))`, fraction(BIG * 11n + BIG * 7n, 77n)],
  [`rational-text(multiply(multiply(big(<${BIG}>, <1>), big(<${BIG}>, <1>)), big(<${BIG}>, <${BIG}>)))`, fraction(BIG * BIG, 1n)],
]

const PROGRAM = `load @term/base/rational
  find rational
  find make-rational
  find make-big-rational
  find rational-text

load @term/base/integer/big
  find make-big-integer

load @term/base/list
  find list
  find join

# a fraction of two whole numbers written as text, so either may be past 2^53
task big
  take numerator, like text
  take denominator, like text
  like rational
  back make-big-rational(make-big-integer(numerator), make-big-integer(denominator))

task by-zero
  like text
  fork
    mark unsafe
    save never, divide(make-rational(1, 2), make-rational(0, 3))
    back rational-text(never)
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

const dir = mkdtempSync(join(tmpdir(), 'term-rational-'))
const only = process.env.RATIONAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'rational' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  const got = ran.form === 'ran' ? ran.output.split('|') : []
  const want = EXPECTED.split('|')
  const differ = want.flatMap((answer, at) => (got[at] === answer ? [] : [`${CASES[at]?.[0] ?? 'division by zero'}: got ${got[at]}, want ${answer}`]))

  ok(`${backend}: fractions answer exactly, past the edge of a whole number too`, ran.form === 'ran' && differ.length === 0, ran.form === 'ran' ? differ.join(' | ') : `${ran.stage}: ${ran.reason}`)
}

console.log(`\nrational-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
