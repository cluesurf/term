// How often today's TypeScript float verbs (node's Math.*, what float.tree
// binds on node) differ from the correctly rounded MPFR result, per verb.
//
// Run: npx tsx task/term/float/census.ts [verb ...]   (all 16 verbs by default)
// Prints `<verb>: <M> misrounded of <N>` per verb, after the oracle's own
// check that exp(1) is 0x4005bf0a8b145769.
//
// A NaN from either side counts as equal to any NaN: node's Math.* returns
// whatever NaN it likes and spec.md section 2.4 fixes the canonical one only
// for the ports. Every other difference, signed zero included, is a miss.

import { BINARY_VERBS, VERBS, hex, isBinary, oracleWords } from './oracle'

const buffer = new DataView(new ArrayBuffer(8))

function toDouble(word: bigint): number {
  buffer.setBigUint64(0, word)
  return buffer.getFloat64(0)
}

function toWord(value: number): bigint {
  buffer.setFloat64(0, value)
  return buffer.getBigUint64(0)
}

const MATH: Record<string, (a: number, b: number) => number> = {
  exponent: a => Math.exp(a),
  'natural-logarithm': a => Math.log(a),
  'logarithm-2': a => Math.log2(a),
  'logarithm-10': a => Math.log10(a),
  sine: a => Math.sin(a),
  cosine: a => Math.cos(a),
  tangent: a => Math.tan(a),
  'arc-sine': a => Math.asin(a),
  'arc-cosine': a => Math.acos(a),
  'arc-tangent': a => Math.atan(a),
  'hyperbolic-sine': a => Math.sinh(a),
  'hyperbolic-cosine': a => Math.cosh(a),
  'hyperbolic-tangent': a => Math.tanh(a),
  'arc-tangent-of': (a, b) => Math.atan2(a, b),
  hypotenuse: (a, b) => Math.hypot(a, b),
  power: (a, b) => Math.pow(a, b),
}

// Useful range per verb, uniform in value: [low, high] for the first argument
// and for the second.
const RANGE: Record<string, [number, number][]> = {
  exponent: [[-750, 710]],
  'natural-logarithm': [[0, 1000]],
  'logarithm-2': [[0, 1000]],
  'logarithm-10': [[0, 1000]],
  sine: [[-100000, 100000]],
  cosine: [[-100000, 100000]],
  tangent: [[-100000, 100000]],
  'arc-sine': [[-1, 1]],
  'arc-cosine': [[-1, 1]],
  'arc-tangent': [[-1000, 1000]],
  'hyperbolic-sine': [[-710, 710]],
  'hyperbolic-cosine': [[-710, 710]],
  'hyperbolic-tangent': [[-20, 20]],
  'arc-tangent-of': [
    [-100, 100],
    [-100, 100],
  ],
  hypotenuse: [
    [-1000, 1000],
    [-1000, 1000],
  ],
  power: [
    [0, 100],
    [-50, 50],
  ],
}

const RANDOM_COUNT = 100000
const MASK = (1n << 64n) - 1n

// Fixed-constant xorshift64*: the same inputs on every run and machine.
function makeRandom(seed: bigint): () => bigint {
  let state = seed
  return () => {
    state ^= state >> 12n
    state ^= (state << 25n) & MASK
    state ^= state >> 27n
    return (state * 0x2545f4914f6cdd1dn) & MASK
  }
}

function isFinitePattern(word: bigint): boolean {
  return ((word >> 52n) & 0x7ffn) !== 0x7ffn
}

function seedFor(verb: string): bigint {
  let seed = 0x9e3779b97f4a7c15n
  for (const character of verb) {
    seed = ((seed ^ BigInt(character.charCodeAt(0))) * 0x100000001b3n) & MASK
  }
  return seed === 0n ? 1n : seed
}

const NEXT_UP = (word: bigint): bigint => word + 1n
const NEXT_DOWN = (word: bigint): bigint => word - 1n

function specials(): bigint[] {
  const base = [
    0,
    -0,
    Infinity,
    -Infinity,
    NaN,
    1,
    -1,
    0.5,
    -0.5,
    2,
    -2,
    10,
    Math.PI / 2,
    -Math.PI / 2,
    Math.PI,
    -Math.PI,
    Number.MIN_VALUE,
    -Number.MIN_VALUE,
    Number.MAX_VALUE,
    -Number.MAX_VALUE,
    2.2250738585072014e-308,
    // exp overflow and underflow thresholds
    709.782712893384,
    -745.1332191019411,
  ]
  const out: bigint[] = []
  for (const value of base) {
    const word = toWord(value)
    out.push(word)
    const stepped = [NEXT_UP(word), NEXT_DOWN(word)]
    const nearPi = Math.abs(value) === Math.PI / 2 || Math.abs(value) === Math.PI
    const nearEdge = Math.abs(value) > 700 && Math.abs(value) < 800
    if (nearPi || nearEdge) out.push(...stepped)
  }
  return [...new Set(out)]
}

function uniform(random: () => bigint, low: number, high: number): number {
  const unit = Number(random() >> 11n) / 2 ** 53
  return low + unit * (high - low)
}

function inputsFor(verb: string): bigint[][] {
  const random = makeRandom(seedFor(verb))
  const arity = isBinary(verb) ? 2 : 1
  const special = specials()
  const rows: bigint[][] = []
  if (arity === 1) {
    for (const word of special) rows.push([word])
  } else {
    for (const a of special) for (const b of special) rows.push([a, b])
  }
  const finite = (): bigint => {
    for (;;) {
      const word = random()
      if (isFinitePattern(word)) return word
    }
  }
  const half = RANDOM_COUNT / 2
  for (let index = 0; index < half; index++) {
    const row: bigint[] = []
    for (let argument = 0; argument < arity; argument++) row.push(finite())
    rows.push(row)
  }
  const ranges = RANGE[verb]
  for (let index = 0; index < RANDOM_COUNT - half; index++) {
    const row: bigint[] = []
    for (let argument = 0; argument < arity; argument++) {
      const [low, high] = ranges[argument]
      row.push(toWord(uniform(random, low, high)))
    }
    rows.push(row)
  }
  return rows
}

function same(expected: bigint, got: bigint): boolean {
  if (expected === got) return true
  return Number.isNaN(toDouble(expected)) && Number.isNaN(toDouble(got))
}

function census(verb: string): void {
  const inputs = inputsFor(verb)
  const expected = oracleWords(verb, inputs)
  const fn = MATH[verb]
  let misrounded = 0
  const examples: string[] = []
  for (let index = 0; index < inputs.length; index++) {
    const row = inputs[index]
    const got = toWord(fn(toDouble(row[0]), row.length > 1 ? toDouble(row[1]) : 0))
    if (!same(expected[index], got)) {
      misrounded++
      if (examples.length < 3) {
        examples.push(`  ${row.map(hex).join(' ')} expected ${hex(expected[index])} got ${hex(got)}`)
      }
    }
  }
  console.log(`${verb}: ${misrounded} misrounded of ${inputs.length}`)
  for (const line of examples) console.log(line)
}

function check(): void {
  const [answer] = oracleWords('exponent', [[toWord(1)]])
  const want = 0x4005bf0a8b145769n
  const [two] = oracleWords('power', [[toWord(2), toWord(10)]])
  const [tiny] = oracleWords('exponent', [[toWord(-745)]])
  console.log(`oracle check: exp(1) = 0x${hex(answer)} ${answer === want ? 'ok' : 'WRONG'}`)
  console.log(`oracle check: pow(2, 10) = ${toDouble(two)} ${toDouble(two) === 1024 ? 'ok' : 'WRONG'}`)
  console.log(`oracle check: exp(-745) = 0x${hex(tiny)} (smallest subnormal is 0000000000000001)`)
  if (answer !== want || toDouble(two) !== 1024) process.exit(1)
}

check()
const wanted = process.argv.slice(2)
for (const verb of wanted.length > 0 ? wanted : VERBS) census(verb)
void BINARY_VERBS
