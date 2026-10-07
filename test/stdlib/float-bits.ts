// The float bit primitives (deck/base/code/float/bits.tree) and the error-free transformations built on them
// (float/double-double.tree), on every backend: note/project/term/decisions-2026-10/float/spec.md 4.1, 4.2 and 7.4.
//
// Words: a float's high and low 32-bit words round trip for +-0, +-inf, the canonical NaN, subnormals, 1.0 (high word
// 1072693248, which fails on a big-endian host) and more, and `x + x` built from the words has the words JavaScript's
// `x + x` has, so `float-from-words` makes a real double and not a copy of its inputs.
//
// Arithmetic: on 1,000 fixed-seed pairs (and a list of edge pairs: subnormals, near the largest float, ties) two-sum,
// fast-two-sum and two-product answer `high + low` EXACTLY equal to a + b (a * b), checked here with BigInt on the
// exact binary expansion of every float, and `high` is the correctly rounded sum (product) JavaScript computes. The
// double-double add and multiply agree with BigInt to a relative 2^-100. A compiler that reassociated or contracted
// float operations would fail the two-sum or the two-product here, on the backend that did it (spec.md 7.4).
//
// The inputs travel as decimal words inside one text, parsed by the program, so the same source runs everywhere and no
// case is inlined as code. Run: npx tsx test/stdlib/float-bits.ts   (FLOAT_ONLY=typescript, rust, swift or kotlin
// runs one)

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

// ---- floats as words, in JavaScript

const view = new DataView(new ArrayBuffer(8))

type Word = [number, number]

const wordsOf = (x: number): Word => {
  view.setFloat64(0, x)

  return [view.getUint32(0), view.getUint32(4)]
}

const floatOf = ([high, low]: Word): number => {
  view.setUint32(0, high)
  view.setUint32(4, low)

  return view.getFloat64(0)
}

const key = ([high, low]: Word): string => `${high} ${low}`

// the exact value of a finite float, times 2^1074, as an integer
const scaled = ([high, low]: Word): bigint => {
  const sign = high >>> 31 === 1 ? -1n : 1n
  const exponent = (high >>> 20) & 0x7ff
  const mantissa = (BigInt(high & 0xfffff) << 32n) | BigInt(low)

  return sign * (exponent === 0 ? mantissa : (mantissa | (1n << 52n)) << BigInt(exponent - 1))
}

const absolute = (x: bigint): bigint => (x < 0n ? -x : x)

// ---- fixed-seed inputs

let state = 0x9e3779b97f4a7c15n
const MASK = (1n << 64n) - 1n

function next(): bigint {
  state ^= (state << 13n) & MASK
  state ^= state >> 7n
  state ^= (state << 17n) & MASK

  return state
}

// a float with a random sign, a random mantissa, and an exponent within +-200 of one
function randomFloat(): number {
  const bits = next()
  const exponent = 1023 + Number(bits % 401n) - 200
  const mantissa = (bits >> 12n) & ((1n << 52n) - 1n)
  const high = Number(((bits >> 63n) << 31n) | (BigInt(exponent) << 20n) | (mantissa >> 32n))

  return floatOf([high, Number(mantissa & 0xffffffffn)])
}

const RANDOM = 1000
const MAX = Number.MAX_VALUE
const TINY = floatOf([0, 1])

// ordered so that |a| >= |b|, which fast-two-sum needs
const order = (a: number, b: number): [number, number] => (Math.abs(a) >= Math.abs(b) ? [a, b] : [b, a])

const PAIRS: [number, number][] = []

for (let at = 0; at < RANDOM; at++) {
  PAIRS.push(order(randomFloat(), randomFloat()))
}

// edge pairs: sums and products are checked only where they cannot overflow or underflow (the two-sum and
// fast-two-sum checks), so the random pairs above carry the product checks
const EDGES: [number, number][] = [
  [TINY, TINY],
  [TINY * 3, -TINY],
  [floatOf([0xfffff, 0xffffffff]), TINY],
  [2 ** -1022, -TINY],
  [MAX, 2 ** 969],
  [MAX, -(MAX / 2)],
  [MAX, 1],
  [1, 2 ** -53],
  [1, 2 ** -54],
  [1, -(2 ** -54)],
  [1 + 2 ** -52, 2 ** -53],
  [1, 0],
  [0, 0],
  [-1, 1],
  [3, -3],
  [2 ** 996, 2 ** 943],
  [1e300, -1e284],
].map(([a, b]) => order(a!, b!))

const ALL = [...PAIRS, ...EDGES]

// a word list for the round trip
const VALUES: Word[] = [
  [0, 0],
  [0x80000000, 0],
  [0x7ff00000, 0],
  [0xfff00000, 0],
  [0x7ff80000, 0],
  [0, 1],
  [0x80000000, 1],
  [0x000fffff, 0xffffffff],
  [0x00100000, 0],
  [0x3ff00000, 0],
  [0xbff00000, 0],
  [0x7fefffff, 0xffffffff],
  [0xffefffff, 0xffffffff],
  [0x400921fb, 0x54442d18],
  [0x3fb99999, 0x9999999a],
  ...Array.from({ length: 24 }, (): Word => wordsOf(randomFloat())),
]

// ---- the program

const CHUNK = 250
const chunks: string[] = []

for (let from = 0; from < ALL.length; from += CHUNK) {
  chunks.push(
    ALL.slice(from, from + CHUNK)
      .flatMap(([a, b]) => [...wordsOf(a), ...wordsOf(b)])
      .join(',')
  )
}

const chunkTasks = chunks.map((words, at) => `task chunk-${at}\n  like text\n  send back, text <${words}>\n`).join('\n')
const chunkCalls = chunks.map((_, at) => `{chunk-${at}()}`).join(',')

const PROGRAM = `load @term/base/float/bits
  find float-high-word
  find float-low-word
  find float-from-words

load @term/base/float/double-double
  find double-double
  find two-sum
  find fast-two-sum
  find two-product
  find double-double-add
  find double-double-multiply

load @term/base/text
  find split
  find char-code-at
  find char-count

load @term/base/list
  find list
  find join

${chunkTasks}
task parse-word
  take s, like text
  like number
  host n
    call char-count
      read s
  save total, code 0
  walk size
    bind base, code 0
    bind head, read n
    hook next
      take site, name i
      save total
        call add
          call multiply
            read total
            code 10
          call subtract
            call char-code-at
              read s
              read i
            code 48
  send back, read total

task float-at
  take words, like list
  take index, like number
  like float
  host high
    call parse-word
      call words/at
        read index
  host low
    call parse-word
      call words/at
        call add
          read index
          code 1
  send back
    call float-from-words
      read high
      read low

task words-of
  take pair, like double-double
  like text
  host a
    call float-high-word
      read pair/high
  host b
    call float-low-word
      read pair/high
  host c
    call float-high-word
      read pair/low
  host d
    call float-low-word
      read pair/low
  send back, text <{a} {b} {c} {d}>

task line-of
  take a, like float
  take b, like float
  like text
  host ab
    call two-sum
      read a
      read b
  host ba
    call two-sum
      read b
      read a
  host fast
    call fast-two-sum
      read a
      read b
  host product
    call two-product
      read a
      read b
  host sum
    call double-double-add
      read product
      read ab
  host times
    call double-double-multiply
      read product
      read ab
  send back, text <{words-of(ab)} {words-of(ba)} {words-of(fast)} {words-of(product)} {words-of(sum)} {words-of(times)}>

task round-trip
  take high, like number
  take low, like number
  like text
  host x
    call float-from-words
      read high
      read low
  host doubled
    call add
      read x
      read x
  send back, text <{float-high-word(x)} {float-low-word(x)} {float-high-word(doubled)} {float-low-word(doubled)}>

task run
  like text
  host all
    text <${chunkCalls}>
  host words
    call split
      read all
      text <,>
  host count
    call divide
      read words/length
      code 4
  save pairs, make list
  walk size
    bind base, code 0
    bind head, read count
    hook next
      take site, name i
      host at
        call multiply
          read i
          code 4
      push(pairs, line-of(float-at(words, at), float-at(words, add(at, 2))))
  save trips, make list
${VALUES.map(([high, low]) => `  push(trips, round-trip(${high}, ${low}))`).join('\n')}
  host one
    code 1.0
  host built
    call float-from-words
      code 1072693248
      code 0
  send back, text <{join(trips, <|>)}#{join(pairs, <|>)}#{float-high-word(one)} {float-high-word(built)}>
`

// ---- the checks

const dir = mkdtempSync(join(tmpdir(), 'term-float-bits-'))
const only = process.env.FLOAT_ONLY ?? ''

const wordList = (text: string): Word[] => {
  const numbers = text.trim().split(' ').map(Number)

  return [
    [numbers[0]!, numbers[1]!],
    [numbers[2]!, numbers[3]!],
  ]
}

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: env => projectResolver(process.cwd(), env), dir, name: 'float-bits' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form !== 'ran') {
    ok(`${backend}: the float bits program builds and runs`, false, `${ran.stage}: ${ran.reason}`)
    continue
  }

  const [tripText, pairText, literalText] = ran.output.split('#')
  const trips = (tripText ?? '').split('|')
  const lines = (pairText ?? '').split('|')

  // words
  const tripFails: string[] = []

  VALUES.forEach((value, at) => {
    const got = (trips[at] ?? '').split(' ').map(Number)
    const x = floatOf(value)
    const doubled = wordsOf(x + x)

    if (key([got[0]!, got[1]!]) !== key(value)) {
      tripFails.push(`round trip ${key(value)} gave ${got[0]} ${got[1]}`)
    }

    if (key([got[2]!, got[3]!]) !== key(doubled)) {
      tripFails.push(`doubling ${key(value)} gave ${got[2]} ${got[3]}, want ${key(doubled)}`)
    }
  })

  ok(`${backend}: words round trip and double like a real float (${VALUES.length} values)`, trips.length === VALUES.length && tripFails.length === 0, tripFails.slice(0, 5).join(' | '))
  ok(`${backend}: float-high-word of the literal 1.0 and of the built one is 1072693248`, literalText === '1072693248 1072693248', `got ${literalText}`)

  // arithmetic
  const fails: Record<string, string[]> = { 'two-sum': [], 'fast-two-sum': [], 'two-product': [], 'double-double-add': [], 'double-double-multiply': [] }
  let checks = 0

  ALL.forEach(([a, b], at) => {
    const parts = (lines[at] ?? '').split(' ').map(Number)
    const pairAt = (n: number): Word[] => wordList(parts.slice(n * 4, n * 4 + 4).join(' '))
    const A = scaled(wordsOf(a))
    const B = scaled(wordsOf(b))
    const sum = A + B
    const rounded = key(wordsOf(a + b))
    const random = at < RANDOM

    const exactSum = (name: string, n: number): void => {
      const [high, low] = pairAt(n) as [Word, Word]
      checks++

      if (scaled(high) + scaled(low) !== sum || key(high) !== rounded) {
        fails[name]!.push(`${a} ${b}: ${key(high)} + ${key(low)}`)
      }
    }

    exactSum('two-sum', 0)
    exactSum('two-sum', 1)
    exactSum('fast-two-sum', 2)

    if (!random) {
      return
    }

    const [productHigh, productLow] = pairAt(3) as [Word, Word]
    checks++

    // the product is exact at scale 2^2148 and the two words at scale 2^1074, so compare them at one scale
    const exactProduct = A * B
    const gotProduct = (scaled(productHigh) + scaled(productLow)) << 1074n

    if (gotProduct !== exactProduct || key(productHigh) !== key(wordsOf(a * b))) {
      fails['two-product']!.push(`${a} ${b}: ${key(productHigh)} + ${key(productLow)}`)
    }

    // x = a * b and y = a + b as exact numerators over 2^2148
    const x = exactProduct
    const y = sum << 1074n
    const [addHigh, addLow] = pairAt(4) as [Word, Word]
    const [mulHigh, mulLow] = pairAt(5) as [Word, Word]
    const gotAdd = (scaled(addHigh) + scaled(addLow)) << 1074n
    const wantAdd = x + y
    const gotMul = (scaled(mulHigh) + scaled(mulLow)) << 3222n
    const wantMul = x * y
    checks += 2

    if (absolute(gotAdd - wantAdd) << 100n > absolute(wantAdd)) {
      fails['double-double-add']!.push(`${a} ${b}`)
    }

    if (absolute(gotMul - wantMul) << 100n > absolute(wantMul)) {
      fails['double-double-multiply']!.push(`${a} ${b}`)
    }
  })

  ok(`${backend}: one result line per pair (${ALL.length})`, lines.length === ALL.length, `got ${lines.length}`)

  for (const [name, list] of Object.entries(fails)) {
    ok(`${backend}: ${name}, ${list.length} fail of ${checks} checks across all five`, list.length === 0, `${list.length} failed, first: ${list.slice(0, 3).join(' | ')}`)
  }
}

console.log(`\nfloat-bits: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
