// The pattern engine (deck/base/code/pattern/) held to its definition. Four witnesses:
//   1. the reference interpreter against V8, on patterns whose meaning the two share (test262's hard cases among them)
//   2. tier B (linear) and tier C (backtracking) against the reference, on hand-written fixtures
//   3. every tier, and the tier the public API picks, against the reference, on generated patterns and inputs
//   4. with PATTERN_NATIVE=rust,swift,kotlin: every case of 1 to 3 run through the public API on each of those
//      backends, built on its real toolchain, and held to node's answer, which 3 already held to the reference. The
//      tier differs by backend (Rust's engine is linear, so more lands native there); the matches may not
// note/term/stdlib/regex-engine.md, "How it is held".
//
// Run: npx tsx test/compile/pattern.ts
//      PATTERN_COUNT=2000 PATTERN_SEED=7 PATTERN_NATIVE=rust,swift,kotlin npx tsx test/compile/pattern.ts
//      (pnpm term:regex-differential)

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'
import { chunked, readRuntime, runProgram } from './pattern-build'
import { runDir } from './run-dir'

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

  const file = join(runDir('term-pattern-'), 'engine.ts')

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
// every case the node legs ran through the public API, with node's answer, for the native leg to replay
const replay: { pattern: string; input: string; want: number[]; feature?: string }[] = []

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

// the engine probe (regex-engine-0001): one row per feature the native tier can be handed, each input chosen where
// the four engines are known to read the same text differently. Node holds each to the reference; the native leg runs
// each on its engine and prints the matrix. A row whose pattern is not native on node says so, since it then probes
// tier B there and the native engine only on Rust
const FEATURES: [string, string, string[]][] = [
  ['literal', 'abc', ['xabcx', 'ABC']],
  ['astral literal', '𝄞+', ['a𝄞𝄞b']],
  ['escaped punctuation', '\\.\\*\\+\\?\\(\\)\\[\\]\\{\\}\\|\\^\\$\\\\/', ['x.*+?()[]{}|^$\\/']],
  ['class range', '[a-cé-ë]+', ['xbéëz']],
  ['astral class', '[\\u{1F600}-\\u{1F60F}]+', ['hi 😀😃!']],
  ['negated class', '[^a-c]+', ['abcé𝄞d']],
  ['dot', 'a.c', ['a\nc', 'a\rc', 'a c', 'aéc', 'a𝄞c']],
  ['dot under s', '(?s)a.c', ['a\nc']],
  ['digit', '\\d+', ['x٣12']],
  ['word', '\\w+', ['éa_1b']],
  ['space', '\\s+', ['a b', 'a\t c', 'a\u000bb']],
  ['not word, digit, space', '\\W\\D\\S', ['é é', '-!x']],
  ['case fold', '(?i)k+', ['xKkKy']],
  ['case fold sigma', '(?i)σ+', ['aΣσςb']],
  ['case fold class', '(?i)[a-c]+', ['xABcy']],
  ['general category', '\\p{Lu}+', ['abcÉCOLE x']],
  ['script', '\\p{Script=Greek}+', ['a αβγ b']],
  ['binary property', '\\p{Alphabetic}+', ['1aé2']],
  ['alternation order', 'a|ab', ['ab']],
  ['lazy', 'a+?', ['aaa']],
  ['counted', 'a{2,3}', ['aaaa', 'a']],
  ['groups', '(a)(?:b)(c)?', ['ab', 'abc']],
  ['named group', '(?<x>a)b', ['ab']],
  ['text start', '^a', ['ba', 'ab']],
  ['text end', 'a$', ['a\n', 'a', 'a\r\n']],
  ['absolute anchors', '\\Aa\\z', ['a', 'a\n']],
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

// 4. the native leg. Each case is written as code point numbers, `p,p,p,;i,i,|`, so no pattern needs escaping into a
// Term text literal, in chunks well under Kotlin's 64 KB constant. The program decodes them, runs each through
// `prepare` and `search-slots` exactly as `find-match` does, and answers one field per case: the slots, each followed
// by a comma, or `-` for no match
const answerOf = (slots: number[]): string => (slots.length === 0 ? '-' : slots.map(n => `${n},`).join(''))

function replayProgram(cases: typeof replay): string {
  const data = cases
    .map(({ pattern, input }) => `${runesOf(pattern).map(n => `${n},`).join('')};${runesOf(input).map(n => `${n},`).join('')}|`)
    .join('')
  return `load @term/base/pattern
  find pattern
  find prepare
  find search-slots
  find open-session

load @term/base/text/unicode
  find to-runes
  find from-runes

host cases
  make list
${chunked(data)}

task answer-of
  take source, like text
  take input, like text
  like text
  save ready
    call prepare(make(pattern, read(source)))
  save slots
    call search-slots(read(ready), call(open-session, read(ready), read(input)), code(0))
  fork test
    hook test
      call is-equal(read(slots/length), code(0))
    hook hold
      send back, text <->
  save line, text <>
  walk list, read slots
    hook next
      take site, name slot
      save line, text <{line}{slot},>
  send back, read line

task compute
  like text
  save out, text <>
  save field, make list
  save source, text <>
  save number, code 0
  walk list, read cases
    hook next
      take site, name chunk
      walk list
        call to-runes(read(chunk))
        hook next
          take site, name c
          fork test
            hook test
              call and
                call is-minimum(read(c), code(48))
                call is-maximum(read(c), code(57))
            hook hold
              save number
                call add(call(multiply, read(number), code(10)), call(subtract, read(c), code(48)))
            hook test
              call is-equal(read(c), code(44))
            hook hold
              call field/push(read(number))
              save number, code 0
            hook test
              call is-equal(read(c), code(59))
            hook hold
              save source
                call from-runes(read(field))
              save field, make list
            hook test
              call is-equal(read(c), code(124))
            hook hold
              save input
                call from-runes(read(field))
              save field, make list
              save answer
                call answer-of(read(source), read(input))
              save out, text <{out}{answer}|>
  send back, read out
`
}

// replays every case on one backend; answers each probe feature's tally as `agreeing/total`, or nothing when the
// replay could not build or run
function replayOn(backend: 'rust' | 'swift' | 'kotlin'): Map<string, string> | undefined {
  const cases = replay
  const want = cases.map(c => answerOf(c.want))
  let output: string

  try {
    output = runProgram(backend, replayProgram(cases), join(process.cwd(), 'test', 'compile', 'pattern-replay.tree'))
  } catch (error) {
    fail++
    console.log(`FAIL  native ${backend}: ${error instanceof Error ? error.message : String(error)}`)

    return
  }

  const got = output.split('|').slice(0, -1)

  if (got.length !== want.length) {
    fail++
    console.log(`FAIL  native ${backend}: ${got.length} answers for ${want.length} cases`)

    return
  }

  let wrong = 0
  const agree = new Map<string, [number, number]>()

  for (let k = 0; k < cases.length; k++) {
    const feature = cases[k]!.feature

    if (feature) {
      const [held, total] = agree.get(feature) ?? [0, 0]
      agree.set(feature, [held + (got[k] === want[k] ? 1 : 0), total + 1])
    }

    if (got[k] === want[k]) {
      pass++
    } else {
      fail++
      wrong++

      if (wrong <= 20) {
        console.log(`FAIL  native ${backend} /${cases[k]!.pattern}/ on ${JSON.stringify(cases[k]!.input)}: want ${want[k]} got ${got[k]}`)
      }
    }
  }

  console.log(`native ${backend}: ${cases.length - wrong} of ${cases.length} cases agree with node`)

  return new Map([...agree].map(([feature, [held, total]]) => [feature, `${held}/${total}`]))
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
      replay.push({ pattern, input, want })
    }
  }

  // the probe rows: each must read, and the public API must give the reference's answer on node
  const offNative: string[] = []

  for (const [feature, pattern, inputs] of FEATURES) {
    let tier: string

    try {
      tier = engine.tierOf(pattern)
    } catch (error) {
      fail++
      console.log(`FAIL  probe ${feature}: /${pattern}/ is refused: ${error instanceof Error ? error.message : String(error)}`)
      continue
    }

    if (tier !== 'native') {
      offNative.push(`${feature} (${tier})`)
    }

    for (const input of inputs) {
      const want = engine.referenceAt(pattern, runesOf(input), 0)

      same(`probe ${feature}`, pattern, input, want, engine.chosenAt(pattern, input, 0))
      replay.push({ pattern, input, want, feature })
    }
  }

  if (offNative.length) {
    console.log(`probe rows not native on node, so tier B there: ${offNative.join(', ')}`)
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
      replay.push({ pattern, input, want })

      if (!backOnly) {
        same('generated linear', pattern, input, want, engine.pikeAt(pattern, runes, 0))
      }
    }
  }

  console.log(`generated: ${count} patterns, tiers ${JSON.stringify(Object.fromEntries(tiers))}`)

  const matrix = new Map<string, Map<string, string>>()

  for (const backend of (process.env.PATTERN_NATIVE ?? '').split(',').filter(Boolean)) {
    if (backend !== 'rust' && backend !== 'swift' && backend !== 'kotlin') {
      throw new Error(`PATTERN_NATIVE names ${backend}: rust, swift or kotlin`)
    }

    const tally = replayOn(backend)

    if (tally) {
      matrix.set(backend, tally)
    }
  }

  // the probe matrix: each feature's cases that agree with node, per engine. Node's own column is the reference
  if (matrix.size) {
    const engines = [...matrix.keys()]
    const width = Math.max(...FEATURES.map(([feature]) => feature.length))
    console.log(`\n${'feature'.padEnd(width)}  ${engines.map(e => e.padEnd(7)).join(' ')}`)

    for (const [feature] of FEATURES) {
      console.log(`${feature.padEnd(width)}  ${engines.map(e => (matrix.get(e)!.get(feature) ?? 'none').padEnd(7)).join(' ')}`)
    }
  }

  console.log(`\npattern: ${pass} pass, ${fail} fail`)

  if (fail > 0) {
    process.exitCode = 1
  }
}

main().catch(error => {
  console.log(`FAIL  the suite stopped: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
