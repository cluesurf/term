// The JSON grammar through feed-mill: no rule silently dropped, and the value dispatch is real.
//
// This is NOT the full round-trip suite. `deck/feed/code/json/mine.tree` does not yet generate a complete reader:
// `mine number` is a span capture and the emitter cannot thread an accumulator through nested rules yet
// (format-mill-0003 records why, and why slicing the cursor instead is unsound). JSON joins
// test/compile/feed-mill-run.ts beside hex and gzip when it does. Putting it there now would mean a known-failing
// suite in the gate.
//
// What this holds is everything that IS true, and it is the guard the work needed:
//
//   NO RULE LOSES A PIECE. Every `mine <name>` reads to an exact, pinned NUMBER of rule objects. This is the check
//   that matters, because the failure mode here is not a crash: `readFeedMineRule` returns undefined for a shape it
//   does not know and that rule VANISHES from the sequence, silently. A `range` bound written as a code point
//   rather than a character (`bind base, code 0x0020`) did exactly that to JSON's `safe-char`, which is every
//   character of every string.
//
//   COUNTING IS NOT ENOUGH ON ITS OWN, and this is why the numbers are pinned rather than merely non-zero: the
//   first version of this suite asked only that each rule read to AT LEAST ONE object, and reintroducing that same
//   `range` defect did not fail it. `safe-char` still read its `not`, so it was 1 instead of 2, and 1 passed.
//
//   THE GENERATED SOURCE PARSES AND MILLS, so what comes out is Term rather than something that only looks like it.
//
//   THE VALUE DISPATCH IS REAL. `value-helper-0` peeks one character and branches to all seven json-value variants
//   by code point, which is the dispatch every hand-written JSON reader makes. Before this it peeked and then fell
//   into `halt <expected a match for value-helper-0>`.
//
// Run: npx tsx test/compile/feed-mill-json.ts

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { readFeedMineGrammar, compileFeedMine } from '@term/make/code/compile/feed-mill'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const GRAMMAR = join(TERM, 'deck/feed/code/json/mine.tree')

// Rules that do NOT read yet, each with the reason. A BASELINE, not permission: this fails if a rule outside the
// list stops reading, and fails if one on it starts, so the list cannot grow quietly or rot. Emptying it is the
// rest of format-mill-0003.
// EMPTY, and it should stay that way. `number` was the last entry: it is a SPAN CAPTURE (`take value, like text`
// with a `bind value` wrapping a bare `mine text`), and it reads since the span rule landed on 2026-08-30. The
// span ACCUMULATES what each read returns rather than slicing the cursor, because text-cursor-compact discards
// consumed text past 64 KiB and resets the position, so a start offset is not a thing a streaming cursor can be
// asked to remember.
const KNOWN_DROPPED: Record<string, string> = {}

// how many rule objects each declared rule reads to, on 2026-08-30. A number that changes is a rule that gained or
// lost a piece, and either is worth stopping for.
// Rules that read to FEWER parts than the grammar gives them, with the reason. A count alone cannot say this: a
// pinned 1 looks as settled as a pinned 4, and only a reader who counted the grammar's children would know one of
// them is wrong. Named here so it is a recorded gap rather than a number nobody questions.
// EMPTY, and it should stay that way. `number` was the last entry: it read 1 of its 4 children because
// `mine maybe` without an explicit `test` had no reader, so the optional sign, fractional part and exponent were
// dropped and only the integer digits survived. A bare maybe is decided by its own FIRST set now, and `number`
// reads as one span over four children (maybe, form, maybe, maybe).
const KNOWN_PARTIAL: Record<string, string> = {}

const RULE_COUNT: Record<string, number> = {
  value: 1,
  string: 3,
  'safe-char': 2,
  escape: 2,
  'unicode-escape': 2,
  'hex-digit': 1,
  // one SPAN, over four children of its own
  number: 1,
  digits: 1,
  object: 5,
  // 6, not 4: `bind key` and `bind value` are named captures and read since the bind rule landed
  pair: 6,
  array: 5,
  true: 1,
  false: 1,
  null: 1,
  whitespace: 1,
}

// all seven json-value variants, as [variant, a code point that selects it]. `number` was the last to arrive: its
// FIRST set has to reach PAST the optional sign to the digits behind it, which is what firstOfSequence knows.
const DISPATCH: [string, number][] = [
  ['string', 34], // "
  ['object', 123], // {
  ['array', 91], // [
  ['true', 116], // t
  ['false', 102], // f
  ['null', 110], // n
  ['number', 45], // -
]

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 200)}` : ''}`)
  }
}

const text = readFileSync(GRAMMAR, 'utf8')
const parsed = parse({ file: GRAMMAR, text })

ok('the JSON grammar parses', parsed.ok)

if (!parsed.ok) {
  console.log(`\nfeed-mill-json: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const grammar = readFeedMineGrammar(parsed.tree)

// every `mine <name>` at column 0 is a rule the grammar declares
const declared = text
  .split('\n')
  .filter(line => line.startsWith('mine '))
  .map(line => line.slice('mine '.length).trim())

const dropped = declared.filter(name => (grammar.get(name) ?? []).length === 0)
const unexplained = dropped.filter(name => !(name in KNOWN_DROPPED))
const fixed = Object.keys(KNOWN_DROPPED).filter(name => !dropped.includes(name))

ok(
  `every declared rule reads (${declared.length - dropped.length} of ${declared.length}, ${Object.keys(KNOWN_DROPPED).length} known)`,
  unexplained.length === 0,
  unexplained.length > 0 ? `dropped with no reason: ${unexplained.join(', ')}` : '',
)

ok(
  'the known-dropped list has not rotted',
  fixed.length === 0,
  fixed.length > 0 ? `${fixed.join(', ')} reads now, so take it off KNOWN_DROPPED` : '',
)

const miscounted = declared
  .map(name => ({ name, got: (grammar.get(name) ?? []).length, want: RULE_COUNT[name] }))
  .filter(entry => entry.want !== undefined && entry.got !== entry.want)

ok(
  `every rule reads to the number of parts it did (${declared.length} rules)`,
  miscounted.length === 0,
  miscounted.map(e => `${e.name}: ${e.got} not ${e.want}`).join(', '),
)

// the partial rules are still partial, and no new one has appeared
const partialNames = Object.keys(KNOWN_PARTIAL)

ok(
  `${partialNames.length} rule(s) read only part of what the grammar gives them, each with a reason`,
  partialNames.every(name => (grammar.get(name) ?? []).length > 0),
  partialNames.join(', '),
)

const source = compileFeedMine(grammar, 'text', '@term/feed/code/base')
const generated = parse({ file: 'json-generated.tree', text: source })

ok('the generated reader parses', generated.ok)

if (generated.ok) {
  ok('the generated reader mills', mill(generated.tree, 'json-generated.tree').ok)
}

// the dispatch: one peek, then a branch per variant
const helper = source.slice(source.indexOf('task value-helper-0'))
const helperEnd = helper.indexOf('\ntask ', 1)
const dispatch = helperEnd < 0 ? helper : helper.slice(0, helperEnd)

for (const [variant, code] of DISPATCH) {
  ok(
    `\`value\` dispatches code ${code} to read-${variant}`,
    // the window is generous because a branch's test can be a chain of ors (`number` is a sign OR a digit range),
    // and what matters is that this code selects this reader, not how tersely the condition is written
    new RegExp(`code ${code}\\)[\\s\\S]{0,240}call read-${variant}\\(`).test(dispatch),
  )
}

// the `halt` is the FALLBACK, and it belongs there: a helper that matched nothing has to refuse. What would be
// wrong is the halt being all there is, which is what it was before the dispatch existed.
const halted = dispatch.indexOf('halt <expected a match for value-helper-0>')
const branched = dispatch.indexOf('call read-string(')

ok(
  '`value` refuses only AFTER trying every branch',
  halted > 0 && branched > 0 && branched < halted,
)

console.log(`\nfeed-mill-json: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
