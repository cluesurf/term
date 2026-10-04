// The pattern engine (deck/base/code/pattern/) held to its definition. Three witnesses:
//   1. the reference interpreter against V8, on patterns whose meaning the two share (test262's hard cases among them)
//   2. tier B (linear) and tier C (backtracking) against the reference, on hand-written fixtures
//   3. every tier, and the tier the public API picks, against the reference, on generated patterns and inputs
// note/term/stdlib/regex-engine.md, "How it is held".
//
// Run: npx tsx test/compile/pattern.ts
//      PATTERN_COUNT=2000 PATTERN_SEED=7 npx tsx test/compile/pattern.ts     (pnpm term:regex-differential)

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'

const baseTree = join(process.cwd(), 'deck', 'base')
const PREFIX = /^@term\/base\//

const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  const file = join(baseTree, path.replace(PREFIX, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

type Engine = {
  referenceAt: (source: string, runes: number[], from: number) => number[]
  pikeAt: (source: string, runes: number[], from: number) => number[]
  backAt: (source: string, runes: number[], from: number) => number[]
  chosenAt: (source: string, input: string, from: number) => number[]
  tierOf: (source: string) => string
  needsBack: (source: string) => boolean
}

const ENTRY = `load @term/base/pattern/reference
  find reference-search

load @term/base/pattern/syntax
  find parse-pattern

load @term/base/pattern/program
  find compile-pattern

load @term/base/pattern/scene
  find make-scene

load @term/base/pattern/pike
  find pike-search

load @term/base/pattern/back
  find back-search

load @term/base/pattern/analyze
  find needs-backtracking

load @term/base/pattern
  find pattern
  find prepare
  find pattern-tier
  find search-slots
  find open-session

task reference-at
  take source, like text
  take runes
    like list
      like number
  take from, like number
  like list
    like number
  send back
    call reference-search(read(source), read(runes), read(from))

task pike-at
  take source, like text
  take runes
    like list
      like number
  take from, like number
  like list
    like number
  save g
    call compile-pattern(call(parse-pattern, read(source)))
  send back
    call pike-search(read(g), call(make-scene, read(runes), false), read(from))

task back-at
  take source, like text
  take runes
    like list
      like number
  take from, like number
  like list
    like number
  save g
    call compile-pattern(call(parse-pattern, read(source)))
  send back
    call back-search(read(g), call(make-scene, read(runes), true), read(from), code(10000000))

task needs-back
  take source, like text
  like boolean
  save parsed
    call parse-pattern(read(source))
  send back
    call needs-backtracking(read(parsed/root))

task tier-of
  take source, like text
  like text
  send back
    call pattern-tier(make(pattern, read(source)))

task chosen-at
  take source, like text
  take input, like text
  take from, like number
  like list
    like number
  save ready
    call prepare(make(pattern, read(source)))
  send back
    call search-slots(read(ready), call(open-session, read(ready), read(input)), read(from))
`

async function loadEngine(): Promise<Engine> {
  const compiled = compile(
    { file: join(process.cwd(), 'test', 'compile', 'pattern-entry.tree'), text: ENTRY },
    { resolve: withNativeEnv('node', stdlibResolver()!) },
  )

  if (!compiled.ok) {
    throw new Error(compiled.diagnostics.map(d => `${d.file}:${d.span.start.line + 1} ${d.message}`).join('\n'))
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-pattern-'))
  const file = join(dir, 'engine.ts')

  writeFileSync(file, `${nativePrelude(compiled.program, 'node', readRuntime)}\n${compiled.typescript}`)

  return (await import(pathToFileURL(file).href)) as Engine
}

const runesOf = (text: string): number[] => [...text].map(c => c.codePointAt(0)!)

// V8's answer as the same slots, in code points
function v8Search(pattern: string, input: string): number[] {
  const m = new RegExp(pattern, 'ud').exec(input)

  if (!m || !m.indices) {
    return []
  }

  const toPoint = (unit: number) => [...input.slice(0, unit)].length

  return m.indices.flatMap(span => (span === undefined ? [-1, -1] : [toPoint(span[0]), toPoint(span[1])]))
}

let pass = 0
let fail = 0

function same(label: string, pattern: string, input: string, want: number[], got: number[]): void {
  if (JSON.stringify(want) === JSON.stringify(got)) {
    pass++
  } else {
    fail++
    console.log(`FAIL  ${label} /${pattern}/ on ${JSON.stringify(input)}: want ${JSON.stringify(want)} got ${JSON.stringify(got)}`)
  }
}

// 1. patterns whose meaning V8 shares: no `.`, no `m`, no `\w`-based `\b` on non-ASCII input
const SHARED: [string, string[]][] = [
  ['abc', ['abc', 'xabcx', 'ab', '']],
  ['a|ab', ['ab', 'b']],
  ['(a|ab)(c|bcd)(d*)', ['abcd', 'acd']],
  ['a*?b', ['aaab', 'b']],
  ['(z)((a+)?(b+)?(c))*', ['zaacbbbcac']],
  ['(a*)*', ['b', 'aab']],
  ['(?:(a)|b)*', ['ab', 'ba']],
  ['(?=(a+))a*b\\1', ['baaabac']],
  ['(.*?)a(?!(a+)b\\2c)\\2(.*)', ['baaabaac']],
  ['(?<=\\$)\\d+(\\.\\d*)?', ['cost $10.53', '$90']],
  ['(?<=(\\d+)(\\d+))$', ['1053']],
  ['(?<=\\1(a))b', ['aab', 'ab']],
  ['(?<word>\\w+) \\k<word>', ['the the', 'the cat']],
  ['\\bfoo\\b', ['foo bar', 'foobar']],
  ['[\\u{1F600}-\\u{1F64F}]+', ['hi 😀😃!']],
  ['(a{0,2})*', ['aaaaa']],
]

// 2. fixtures for the two tiers Term runs itself
const LINEAR: [string, string[]][] = [
  ['(?:a|())*', ['aab']],
  ['(a|)*b', ['aab']],
  ['(?<=(a|ab))c', ['abc']],
  ['((?<=a)b)+', ['abbb']],
  ['(?i)ǅ+', ['ǄǅǆDž']],
  ['(?m)^b$', ['a\nb\nc']],
  ['(?s).+', ['a\nb']],
  ['.+', ['a\nb']],
  ['\\p{Lu}+', ['abcÉCOLE']],
  ['x\\B', ['xé']],
]

const BACKTRACKING: [string, string[]][] = [
  ['(a)\\1', ['aa', 'ab']],
  ['(\\w)(?=\\1)', ['abccd']],
  ['(?>a+)b', ['aaab']],
  ['(?>a|ab)c', ['abc', 'ac']],
  ['a++a', ['aaa']],
  ['(?i)(a)\\1', ['aA']],
]

// 3. a seeded generator, so a failure replays
let seed = Number(process.env.PATTERN_SEED ?? 1)
const random = () => {
  seed = (seed * 1103515245 + 12345) % 2147483648
  return seed / 2147483648
}
const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)]!
let groups = 0

function atom(depth: number): string {
  const roll = random()

  if (depth > 2 || roll < 0.35) {
    return pick(['a', 'b', 'a', 'b', '[ab]', '[^a]', '.', '\\w', '\\s', 'c'])
  }

  if (roll < 0.5) {
    groups++
    return `(${alternation(depth + 1)})`
  }

  if (roll < 0.58) {
    return `(?:${alternation(depth + 1)})`
  }

  if (roll < 0.66) {
    return `(?${pick(['=', '!', '<=', '<!'])}${alternation(depth + 1)})`
  }

  if (roll < 0.71) {
    return `(?>${alternation(depth + 1)})`
  }

  if (roll < 0.8 && groups > 0) {
    return `\\${1 + Math.floor(random() * groups)}`
  }

  if (roll < 0.88) {
    return pick(['^', '$', '\\b', '\\B'])
  }

  return pick(['a', 'b', 'ab'])
}

function quantified(depth: number): string {
  const base = atom(depth)

  if (/^[\\^$]|^\(\?[=!<]/.test(base) && !/^\\[0-9w]|^\\s/.test(base)) {
    return base
  }

  if (random() < 0.55) {
    return base
  }

  return `${base}${pick(['*', '+', '?', '{2}', '{0,2}', '{1,}', '{2,3}'])}${pick(['', '', '?', '+'])}`
}

function sequence(depth: number): string {
  let out = ''

  for (let i = 1 + Math.floor(random() * 3); i > 0; i--) {
    out += quantified(depth)
  }

  return out
}

function alternation(depth: number): string {
  return random() < 0.25 ? `${sequence(depth)}|${sequence(depth)}` : sequence(depth)
}

function makePattern(): string {
  groups = 0

  return (random() < 0.15 ? pick(['(?i)', '(?m)', '(?s)']) : '') + alternation(0)
}

function makeInput(): string {
  let out = ''

  for (let i = Math.floor(random() * 7); i > 0; i--) {
    out += pick(['a', 'b', 'A', ' ', '\n', 'c'])
  }

  return out
}

async function main(): Promise<void> {
  const engine = await loadEngine()

  for (const [pattern, inputs] of SHARED) {
    for (const input of inputs) {
      same('reference vs v8', pattern, input, v8Search(pattern, input), engine.referenceAt(pattern, runesOf(input), 0))
    }
  }

  for (const [pattern, inputs] of [...SHARED, ...LINEAR]) {
    if (engine.needsBack(pattern)) {
      continue
    }

    for (const input of inputs) {
      same('linear', pattern, input, engine.referenceAt(pattern, runesOf(input), 0), engine.pikeAt(pattern, runesOf(input), 0))
    }
  }

  for (const [pattern, inputs] of [...SHARED, ...LINEAR, ...BACKTRACKING]) {
    for (const input of inputs) {
      const want = engine.referenceAt(pattern, runesOf(input), 0)

      same('backtrack', pattern, input, want, engine.backAt(pattern, runesOf(input), 0))
      same('chosen', pattern, input, want, engine.chosenAt(pattern, input, 0))
    }
  }

  const count = Number(process.env.PATTERN_COUNT ?? 150)
  const tiers = new Map<string, number>()

  for (let n = 0; n < count; n++) {
    const pattern = makePattern()
    let tier: string

    try {
      tier = engine.tierOf(pattern)
    } catch {
      continue
    }

    tiers.set(tier, (tiers.get(tier) ?? 0) + 1)

    const backOnly = engine.needsBack(pattern)

    for (let k = 0; k < 4; k++) {
      const input = makeInput()
      const runes = runesOf(input)
      const want = engine.referenceAt(pattern, runes, 0)

      same('generated back', pattern, input, want, engine.backAt(pattern, runes, 0))
      same(`generated ${tier}`, pattern, input, want, engine.chosenAt(pattern, input, 0))

      if (!backOnly) {
        same('generated linear', pattern, input, want, engine.pikeAt(pattern, runes, 0))
      }
    }
  }

  console.log(`generated: ${count} patterns, tiers ${JSON.stringify(Object.fromEntries(tiers))}`)
  console.log(`\npattern: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.log(`FAIL  the suite stopped: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
