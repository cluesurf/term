// The pattern engine per target (regex-engine-0010): every pattern of a suite, on every backend, under EVERY tier that
// can run it, timed by the backend's own clock inside the built program. The tier rule in pattern/analyze.tree is
// analytic (native where the engine cannot hang on the pattern, else tier B, else tier C); this is what measures it.
//
// For each pattern it prints the tier the rule chose and the microseconds per search under each tier that can run it
// (`-` where one cannot), and checks:
//
//   agree      every tier finds the same number of matches. A tier that finds a different number is a meaning
//              bug, and fails the run whatever the times say
//   rule       where the rule chose native, native is faster than tier B: the one claim the rule makes about speed.
//              A loss is reported with both times and fails the run only with --strict, since one noisy measurement
//              is not a rule. Tier B is chosen over tier C for its bound, not its speed (tier C's step budget is per
//              search, so it raises on a long or catastrophic input where tier B answers), and what that bound
//              costs is printed beside each tier B row rather than judged
//
//   pnpm term:pattern-bench                      node, rust, swift, kotlin
//   pnpm term:pattern-bench --only rust          one backend
//   pnpm term:pattern-bench --strict             a rule loss fails too
//
// The built programs come from test/compile/pattern-build.ts, the same builder the differential uses.

import { join } from 'node:path'
import { chunked, runProgram, type Backend } from '../../test/compile/pattern-build'
import { TERM_ROOT } from './root'

const args = process.argv.slice(2)
const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined
const strict = args.includes('--strict')

// the suite: what people write, one row per shape the tier rule tells apart. Input 0 is the prose, input 1 the
// catastrophic text (2,000 `a` then `b`)
const SUITE: [string, number][] = [
  ['\\d+', 0],
  ['[A-Z][a-z]+', 0],
  ['(?i)the', 0],
  ['\\p{Lu}\\p{Ll}+', 0],
  ['(?:cat|dog|bird)s?', 0],
  ['\\$\\d+\\.\\d\\d', 0],
  ['[a-z]+ing', 0],
  ['a*b', 0],
  ['\\b\\w+\\b', 0],
  ['(?<=\\$)\\d+', 0],
  ['\\w+(?=,)', 0],
  ['(\\w)\\1', 0],
  ['(a+)+$', 1],
]

// 20,000 characters of prose: words, capitals, prices, doubled letters, commas, and a few letters past ASCII
function prose(): string {
  const words = ['the', 'cat', 'sat', 'on', 'a', 'mat', 'running', 'book', 'letter', 'Paris', 'Élan', 'Σοφία', 'dogs', 'bird', 'jumping', 'see', 'tall', 'The']
  let seed = 7
  let out = ''
  // the census (item 0201, T054): the generator is the exact LCG, and it draws from the high bits (the low bits of an
  // exact power-of-two LCG have a short period). The pieces are counted, as are the shapes the suite's patterns look for
  const pieces = new Set<string>()
  const met = { price: 0, number: 0, comma: 0, 'non-ASCII word': 0 }
  let draws = 0

  while (out.length < 20000) {
    seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff // exact (T054)
    const bits = seed >>> 8
    const roll = bits % 23
    const piece = roll === 0 ? `$${bits % 900}.${String(bits % 100).padStart(2, '0')} ` : roll === 1 ? `${bits % 10000}, ` : `${words[bits % words.length]}${roll === 2 ? ',' : ''} `

    draws++
    pieces.add(piece)
    if (roll === 0) met.price++
    else if (roll === 1) met.number++
    else {
      if (roll === 2) met.comma++
      if (/[^\x00-\x7f]/.test(piece)) met['non-ASCII word']++
    }
    out += piece
  }

  if (!proseCounted) {
    proseCounted = true
    console.log(`pattern-bench prose census: ${draws} generated pieces, ${pieces.size} distinct; hard cases ${Object.entries(met).map(([k, n]) => `${k}: ${n}`).join('; ')}`)
    const missing = Object.entries(met).filter(([, n]) => n === 0)
    if (pieces.size === 0 || missing.length > 0) throw new Error(`pattern-bench prose census FAILED: ${pieces.size === 0 ? 'no piece' : `a hard case never met: ${missing.map(([k]) => k).join(', ')}`}`)
  }

  return out
}

let proseCounted = false

const points = (text: string): string => [...text].map(c => `${c.codePointAt(0)},`).join('')

function benchProgram(): string {
  const cases = SUITE.map(([source, input]) => `${points(source)};${input}|`).join('')

  return `load @term/base/pattern
  find pattern
  find prepare
  find with-program
  find prepared-pattern
  find find-matches-prepared

load @term/base/pattern/analyze
  find tier-native
  find tier-linear
  find tier-backtrack

load @term/base/clock
  find now

load @term/base/text/unicode
  find to-runes
  find from-runes

host prose
  make list
${chunked(points(prose()))}

host cases
  make list
${chunked(cases)}

# the text a list of chunks of code point numbers spells
task decode
  take chunks
    like list
      like text
  like text
  save runes, make list
  save number, code 0
  walk list, read chunks
    hook next
      take site, name chunk
      walk list
        call to-runes(read(chunk))
        hook next
          take site, name c
          fork test
            hook test
              call is-equal(read(c), code(44))
            hook hold
              call runes/push(read(number))
              save number, code 0
            hook miss
              save number
                call add(call(multiply, read(number), code(10)), call(subtract, read(c), code(48)))
  send back
    call from-runes(read(runes))

task attack
  like text
  save out, text <>
  save k, code 0
  walk test
    hook test
      call is-below(read(k), code(2000))
    hook step
      save out, text <{out}a>
      save k
        call add(read(k), code(1))
  send back, text <{out}b>

# the same prepared pattern, run on another tier
task on-tier
  take ready, like prepared-pattern
  take tier, like number
  like prepared-pattern
  send back
    make prepared-pattern
      bind source, read ready/source
      bind groups, read ready/groups
      bind names, read ready/names
      bind tier, read tier
      bind fallback, read ready/fallback
      bind native, read ready/native
      bind program, read ready/program
      bind folds, read ready/folds
      bind words, read ready/words
      bind dfas, read ready/dfas

# microseconds per search, then the match count, as micros:count. The best of five trials, each repeating for at
# least 20 ms of the clock so a millisecond clock still measures a fast search: other work on the machine can only
# make a trial slower, so the fastest is the one nearest the search's own cost
task time-on
  take ready, like prepared-pattern
  take input, like text
  like text
  save count, code 0
  save best, code -1
  save trial, code 0
  walk test
    hook test
      call is-below(read(trial), code(5))
    hook step
      save turns, code 0
      save start
        call now
      save elapsed, code 0
      walk test
        hook test
          call and
            call is-below(read(elapsed), code(20))
            call is-below(read(turns), code(100000))
        hook step
          save found
            call find-matches-prepared(read(ready), read(input))
          save count, read found/length
          save turns
            call add(read(turns), code(1))
          save elapsed
            call subtract(call(now), read(start))
      save micros
        call divide(call(multiply, read(elapsed), code(1000)), read(turns))
      fork test
        hook test
          call or
            call is-below(read(best), code(0))
            call is-below(read(micros), read(best))
        hook hold
          save best, read micros
      save trial
        call add(read(trial), code(1))
  send back, text <{best}:{count}>

# one row: the chosen tier, then native, linear and backtrack, each micros:count or -
task row
  take source, like text
  take input, like text
  like text
  # with its program, which a native pattern is prepared without: every tier is timed here
  save ready
    call with-program(call(prepare, make(pattern, read(source))))
  save chosen, text <backtrack>
  fork test
    hook test
      call is-equal(read(ready/tier), read(tier-native))
    hook hold
      save chosen, text <native>
    hook test
      call is-equal(read(ready/tier), read(tier-linear))
    hook hold
      save chosen, text <linear>
  save native, text <->
  fork test
    hook test
      call is-above(read(ready/native/length), code(0))
    hook hold
      save native
        call time-on(call(on-tier, read(ready), read(tier-native)), read(input))
  # tier B can run the pattern when Term's own tier for it is B: \`fallback\`, since \`tier\` may be native
  save linear, text <->
  fork test
    hook test
      call is-equal(read(ready/fallback), read(tier-linear))
    hook hold
      save linear
        call time-on(call(on-tier, read(ready), read(tier-linear)), read(input))
  save back
    call time-guarded(call(on-tier, read(ready), read(tier-backtrack)), read(input))
  send back, text <{chosen} {native} {linear} {back}>

# tier C on a pattern whose work grows past its budget raises pattern-budget, which is the answer for that cell
task time-guarded
  take ready, like prepared-pattern
  take input, like text
  like text
  fork
    mark unsafe
    send back
      call time-on(read(ready), read(input))
  halt take
    take e
    send back, text <budget>

task compute
  like text
  save texts, make list
  call texts/push(call(decode, read(prose)))
  call texts/push(call(attack))
  save out, text <>
  save field, make list
  save number, code 0
  save source, text <>
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
              save answer
                call row(read(source), call(get, read(texts), read(number)))
              save number, code 0
              save out, text <{out}{answer}|>
  send back, read out
`
}

// a cell that cannot run is absent; one that raised pattern-budget is an unbounded time, so it loses to anything
type Cell = { micros: number; count: number } | undefined
const cellOf = (text: string): Cell => {
  if (text === '-') {
    return undefined
  }

  if (text === 'budget') {
    return { micros: Number.POSITIVE_INFINITY, count: -1 }
  }

  const [micros, count] = text.split(':').map(Number) as [number, number]

  return { micros, count }
}

const BACKENDS: Backend[] = ['node', 'rust', 'swift', 'kotlin']
let failed = 0
let losses = 0

for (const backend of BACKENDS) {
  if (only && backend !== only) {
    continue
  }

  let output: string

  try {
    output = runProgram(backend, benchProgram(), join(TERM_ROOT, 'test/compile/pattern-bench.tree'))
  } catch (error) {
    failed++
    console.log(`FAIL  ${backend}: ${error instanceof Error ? error.message : String(error)}`)
    continue
  }

  const rows = output.split('|').slice(0, -1)
  console.log(`\n${backend}${' '.repeat(22 - backend.length)}chosen     native µs  linear µs  backtrack µs  matches`)

  rows.forEach((row, i) => {
    const [chosen, ...rest] = row.split(' ') as [string, string, string, string]
    const [native, linear, back] = rest.map(cellOf) as [Cell, Cell, Cell]
    const counts = new Set([native, linear, back].filter(c => c && c.count >= 0).map(c => c!.count))
    const show = (c: Cell) => (!c ? '-' : c.count < 0 ? 'budget' : String(c.micros)).padStart(9)
    const source = SUITE[i]![0]
    let note = ''

    if (counts.size > 1) {
      failed++
      note = '  DISAGREE: the tiers found different counts'
    }

    // the rule's one speed claim: where it chose native, native is faster than tier B. Within 10%, or 5 µs, is the
    // clock's noise and not a loss
    if (chosen === 'native' && native && linear && native.micros > linear.micros * 1.1 && native.micros - linear.micros > 5) {
      losses++
      note += `  rule loses: native ${native.micros} µs, linear ${linear.micros} µs`
    }

    // tier B over tier C is chosen for its bound, never for speed: tier C's budget is per search, so it can raise on
    // a long input or a catastrophic one where tier B answers. What that bound costs is printed, as a measurement
    if (chosen === 'linear' && linear && back && back.count >= 0) {
      note += `  tier C ${(linear.micros / back.micros).toFixed(1)}x faster here, unbounded`
    }

    console.log(`  ${source.padEnd(20)}${chosen.padEnd(9)}${show(native)}  ${show(linear)}  ${show(back).padStart(12)}  ${[...counts].join('/')}${note}`)
  })
}

console.log(`\npattern-bench: ${failed} failed, ${losses} rule loss${losses === 1 ? '' : 'es'}`)

if (failed > 0 || (strict && losses > 0)) {
  process.exitCode = 1
}
