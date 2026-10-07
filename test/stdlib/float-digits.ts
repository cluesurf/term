// The shortest round-trip decimal digits of a float (deck/base/code/text/format/digits.tree, decision D7,
// term/decisions-2026-10/locale item 0003) on every backend, held to JavaScript's `Number` toString, which ECMA-402
// rounds. 20,000 floats from a seeded generator: the hard cases first (zero and negative zero, the largest and the
// smallest, the smallest normal, every power of two, every power of ten with its neighbors a unit in the last place
// either side, 1e21 where JavaScript changes how it writes), then subnormals, halfway decimals (1.005), dyadic halves,
// short decimals, and random bit patterns. ONE Term program per backend reads the cases from a file, never inline, and
// writes `<sign>:<digits>:<exponent>` per case, which is compared with what JavaScript's own text gives.
//
// The cases are written as 17 significant digits, never the shortest text, so the input is the float exactly and does
// not hand a backend the answer.
//
// Run: npx tsx test/stdlib/float-digits.ts   (FLOAT_ONLY=typescript, rust, swift or kotlin runs one;
//      FLOAT_LIMIT=n keeps the first n cases, for a quick look)

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from '../compile/shared/run-on'

const TOTAL = 20_000

// xorshift64*, seeded, so the corpus is the same on every run and every machine
let state = 0x9e3779b97f4a7c15n
const MASK = (1n << 64n) - 1n

function next(): bigint {
  state ^= state >> 12n
  state ^= (state << 25n) & MASK
  state ^= state >> 27n
  state &= MASK

  return (state * 0x2545f4914f6cdd1dn) & MASK
}

const below = (n: number): number => Number(next() % BigInt(n))

const view = new DataView(new ArrayBuffer(8))

function fromBits(bits: bigint): number {
  view.setBigUint64(0, bits & MASK)

  return view.getFloat64(0)
}

function bitsOf(x: number): bigint {
  view.setFloat64(0, x)

  return view.getBigUint64(0)
}

// the float one unit in the last place from `x`, toward larger magnitude when `up`
function neighbor(x: number, up: boolean): number {
  const bits = bitsOf(x)

  return fromBits(up ? bits + 1n : bits - 1n)
}

const corpus: number[] = []
const push = (x: number): void => {
  corpus.push(x)
}

// 1 the hard cases
;[0, -0, Number.MAX_VALUE, -Number.MAX_VALUE, Number.MIN_VALUE, -Number.MIN_VALUE, 2.2250738585072014e-308, 2.225073858507201e-308, 1e21, -1e21, 1e22, 1e23, 9007199254740993, 9007199254740992, 0.1 + 0.2, 1.005, 1.015, 4.35, NaN, Infinity, -Infinity, 123456789.12345679, 5e-324, 1e-7, 1e-6, 0.000001234].forEach(push)

// 2 every power of two, and the neighbors of the largest and smallest
for (let k = -1074; k <= 1023; k++) {
  push(k < -1022 ? fromBits(1n << BigInt(k + 1074)) : Math.pow(2, k))
}

// 3 every power of ten with its neighbors a unit in the last place either side
for (let k = -323; k <= 308; k++) {
  const x = Number(`1e${k}`)
  push(x)
  push(neighbor(x, true))
  push(neighbor(x, false))
  push(-x)
}

// 4 subnormals: a mantissa of 1 to 52 bits
for (let i = 0; i < 3000; i++) {
  const width = 1 + below(52)
  const mantissa = (next() & ((1n << BigInt(width)) - 1n)) | 1n
  push(fromBits(mantissa) * (below(2) === 0 ? 1 : -1))
}

// 5 halfway decimals: a short decimal ending in 5 (1.005, 0.125, 2.5, 1234.5, 12.345), and its neighbors
for (let i = 0; i < 2000; i++) {
  const whole = below(10 ** (1 + below(8)))
  const places = 1 + below(6)
  const text = `${whole}.${String(below(10 ** places)).padStart(places, '0')}5`
  push(Number(text) * (below(4) === 0 ? -1 : 1))
}

// 6 dyadic halves: k times a power of two, which have the most digits and halves that are exact in binary
for (let i = 0; i < 1500; i++) {
  push(Number(next() >> BigInt(1 + below(60))) * Math.pow(2, -below(80)) * (below(2) === 0 ? 1 : -1))
}

// 7 short decimals: up to six digits times a power of ten
for (let i = 0; i < 2500; i++) {
  push(Number(`${1 + below(999_999)}e${below(61) - 30}`) * (below(4) === 0 ? -1 : 1))
}

// 8 integers around the places JavaScript changes how it writes: 1e15 to 1e22, and around 2^53
for (let i = 0; i < 1000; i++) {
  const around = [1e15, 1e16, 1e17, 1e20, 1e21, 1e22, 2 ** 53, 2 ** 63, 2 ** 64][below(9)]!

  push(around + below(2000) - 1000)
}

// 9 random bit patterns, finite only, to fill the rest
while (corpus.length < TOTAL) {
  const x = fromBits(next())

  if (Number.isFinite(x)) {
    push(x)
  }
}

const cases = corpus.slice(0, TOTAL)

// 17 significant digits, which reads back as the float exactly and is not the shortest text
function written(x: number): string {
  if (Number.isNaN(x)) {
    return 'NaN'
  }

  if (x === Infinity) {
    return 'Infinity'
  }

  if (x === -Infinity) {
    return '-Infinity'
  }

  return Object.is(x, -0) ? '-0' : x.toExponential(16)
}

// what JavaScript's own text gives: the digits with no leading or trailing zero, and the exponent
function expected(x: number): string {
  if (Number.isNaN(x)) {
    return '+:NaN:0'
  }

  if (!Number.isFinite(x)) {
    return `${x < 0 ? '-' : '+'}:Infinity:0`
  }

  const sign = x < 0 || Object.is(x, -0) ? '-' : '+'
  const match = /^(\d+)(?:\.(\d+))?(?:e([+-]\d+))?$/.exec(String(Math.abs(x)))

  if (!match) {
    throw new Error(`unreadable ${String(x)}`)
  }

  const fraction = match[2] ?? ''
  let digits = (match[1] ?? '') + fraction
  let exponent = Number(match[3] ?? '0') - fraction.length
  digits = digits.replace(/^0+/, '')

  const trimmed = digits.replace(/0+$/, '')
  exponent += digits.length - trimmed.length

  return trimmed === '' ? `${sign}:0:0` : `${sign}:${trimmed}:${exponent}`
}

const limit = Number(process.env.FLOAT_LIMIT ?? cases.length)
const used = cases.slice(0, limit)
const want = used.map(expected)

const dir = mkdtempSync(join(tmpdir(), 'term-float-digits-'))
const casesPath = join(dir, 'cases.txt')
writeFileSync(casesPath, `${used.map(written).join('\n')}\n`)

const PROGRAM = `load @term/base/text/format/digits
  find shortest-digits

load @term/base/text
  find split
  find char-count

load @term/base/text/number
  find host-parse-float

load @term/base/file
  find read

load @term/base/list
  find list
  find join

task run
  like text
  save out, make list
  save rows
    call split
      call read
        text <${casesPath}>
      text <\\n>
  walk list, read rows
    hook next
      take site, name row
      fork test
        hook test
          call is-above
            call char-count
              read row
            code 0
        hook hold
          save d
            call shortest-digits
              call host-parse-float
                read row
          save sign, text <+>
          fork test
            hook test
              read d/negative
            hook hold
              save sign, text <->
          push
            read out
            text <{sign}:{d/digits}:{d/exponent}>
  send back
    call join
      read out
      text <|>
`

const only = process.env.FLOAT_ONLY ?? ''
let failed = false

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'float-digits' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form !== 'ran') {
    console.log(`${backend} FAILED ${ran.stage}: ${ran.reason}`)
    failed = true
    continue
  }

  const got = ran.output.split('|')
  const bad: string[] = []
  let agree = 0

  used.forEach((x, at) => {
    if (got[at] === want[at]) {
      agree++
    } else {
      bad.push(`${written(x)}: got ${JSON.stringify(got[at])}, JavaScript ${JSON.stringify(want[at])}`)
    }
  })

  console.log(`${backend} ${agree} of ${used.length}`)

  for (const line of bad.slice(0, 10)) {
    console.log(`  ${line}`)
  }

  if (agree !== used.length || got.length !== used.length) {
    failed = true
  }
}

if (failed) {
  process.exit(1)
}
