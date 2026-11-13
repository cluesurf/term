// A text's length counts code points (note/project/term/stdlib/semantics.md), so on TypeScript it is a walk of the text
// once the text holds a surrogate. A loop whose test reads `text/length` read it again on every pass, and a 150 KB text
// with one astral character took minutes (item term-self-host-001-1211, traps T-0680b and T-1205). The runtime keeps
// the count of its last few long texts, so the loop reads it once. This checks that every text operation still answers
// what the code points say, on texts the cache hits, misses and drops, and that the loop is linear.
// Run: npx tsx test/compile/text-length-cache.ts

import { transformSync } from 'esbuild'
import { textPrelude } from '@term/make/code/compile/typescript'

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

type Text = {
  length(s: string): number
  indexOf(s: string, n: string, from?: number): number
  lastIndexOf(s: string, n: string): number
  substring(s: string, a: number, b?: number): string
  charAt(s: string, i: number): string
  cursorCharAt(s: string, i: number, c: number[]): string
}

const names = ['length', 'indexOf', 'lastIndexOf', 'substring', 'charAt', 'cursorCharAt']
const runtime = textPrelude(names.map(name => `__termText_${name}(x)`).join('\n'))
const T = new Function(
  transformSync(`${runtime}\nreturn { ${names.map(name => `${name}: __termText_${name}`).join(', ')} }`, {
    loader: 'ts',
  }).code,
)() as Text

// ---- the meaning, by code points ----
const points = (s: string): string[] => Array.from(s)
const clamp = (x: number, n: number): number => Math.min(Math.max(x, 0), n)
const want = {
  length: (s: string): number => points(s).length,
  indexOf(s: string, n: string, from: number): number {
    const f = clamp(from, points(s).length)
    if (n === '') return f
    const found = s.indexOf(n, points(s).slice(0, f).join('').length)
    return found < 0 ? -1 : points(s.slice(0, found)).length
  },
  lastIndexOf(s: string, n: string): number {
    const found = s.lastIndexOf(n)
    return found < 0 ? -1 : points(s.slice(0, found)).length
  },
  substring(s: string, a: number, b: number): string {
    const all = points(s)
    let x = clamp(a, all.length)
    let y = clamp(b, all.length)
    if (x > y) [x, y] = [y, x]
    return all.slice(x, y).join('')
  },
  charAt: (s: string, i: number): string => (i >= 0 ? (points(s)[i] ?? '') : ''),
}

let seed = 1211
const rand = (n: number): number => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff
  return seed % n
}
// lone halves of a pair too, which count as one code point each
const pieces = ['a', 'b', ' ', 'é', '中', '𝄞', '😀', '\ud800', '\udc00', 'xyz', '\n']
const texts: string[] = []
for (let t = 0; t < 300; t++) {
  const size = [0, 1, 5, 63, 64, 65, 200, 3000][rand(8)]!
  let s = ''
  while (s.length < size) s += pieces[rand(pieces.length)]
  texts.push(s)
}

let calls = 0
let differ = ''
const same = (what: string, got: unknown, expected: unknown): void => {
  calls++
  if (got !== expected && differ === '') differ = `${what}: ${JSON.stringify(got)} for ${JSON.stringify(expected)}`
}
for (let round = 0; round < 20000; round++) {
  const s = texts[rand(texts.length)]!
  const n = s.length + 2
  const needle = pieces[rand(pieces.length)]!
  const kind = rand(5)
  if (kind === 0) same('length', T.length(s), want.length(s))
  if (kind === 1) {
    const f = rand(n) - 1
    same('indexOf', T.indexOf(s, needle, f), want.indexOf(s, needle, f))
  }
  if (kind === 2) same('lastIndexOf', T.lastIndexOf(s, needle), want.lastIndexOf(s, needle))
  if (kind === 3) {
    const a = rand(n) - 1
    const b = rand(n) - 1
    same('substring', T.substring(s, a, b), want.substring(s, a, b))
  }
  if (kind === 4) {
    const i = rand(n) - 1
    same('charAt', T.charAt(s, i), want.charAt(s, i))
  }
}
ok('every text operation answers by code points, the cache hit, missed and dropped', differ === '', `${calls} calls, ${differ}`)

// a kept text is never mistaken for another of the same units' length
const one = `${'a'.repeat(100)}𝄞`
const other = `${'b'.repeat(99)}𝄞𝄞`.slice(0, one.length)
ok('two long texts of one unit length keep their own counts', T.length(one) === 101 && T.length(other) === want.length(other) && T.length(one) === 101)

// ---- linear: a loop whose test reads the length, over 150 KB holding one astral character ----
const SIZE = 150000
const plain = 'abcdefghij '.repeat(SIZE / 11 + 1).slice(0, SIZE - 2)
let sink = 0
function loop(s: string): { passes: number; ms: number } {
  const c = [0, 0]
  let i = 0
  const started = performance.now()
  // the body makes a 100-unit token and reads its length, as a scanner does, so a cache of the last texts read must
  // still hold the loop's own. A quadratic loop is cut at 15 s, so the check fails fast
  while (i < T.length(s)) {
    sink += T.cursorCharAt(s, i, c).length
    if (i % 50 === 0) sink += T.length(s.slice(i, i + 100))
    i++
    if (i % 1000 === 0 && performance.now() - started > 15000) break
  }
  return { passes: i, ms: performance.now() - started }
}
const atEnd = loop(`${plain}𝄞`)
const atStart = loop(`𝄞${plain}`)
// before item 1211 these took about 50 s and 90 s; linear they take about 1 s each
ok('a 150 KB loop reading the length in its test ends in under 15 s (astral at the end)', atEnd.passes === SIZE - 1 && atEnd.ms < 15000, `${atEnd.passes} passes, ${atEnd.ms.toFixed(0)} ms`)
ok('and with the astral character first', atStart.passes === SIZE - 1 && atStart.ms < 15000, `${atStart.passes} passes, ${atStart.ms.toFixed(0)} ms`)
console.log(`  astral at the end: ${atEnd.ms.toFixed(0)} ms, at the start: ${atStart.ms.toFixed(0)} ms (${sink} units read)`)

console.log(`\n${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
