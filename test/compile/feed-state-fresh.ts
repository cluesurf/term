// A feed mill compile starts from its own counters (item term-self-host-001-0058, decided by 0009, spec.md section
// 4.8). The original kept `inRepetition` and `inSpan` in module variables, so a compile that threw inside a list or a
// span left them raised, and every compile after it in the process wrote a repetition's bare `halt` where a rule
// outside any repetition reports what it expected. compile/feed-compile.tree `compile-feed-mine` now makes a fresh
// `feed-state` at its start, so a compile that throws, then a second compile, gives what the second gives alone.
// Diverges from the original (decision 027): after a throw the original's next compile carried the raised counters.
// Run from deck/term/deck/term: npx tsx test/compile/feed-state-fresh.ts
import { parse } from '@term/make/code/parser/tree'
import type { RootNode } from '@term/make/code/parser/narrow'
import {
  compileFeedMine,
  readFeedMineGrammar,
  type FeedMineGrammar,
  type FeedMineRule,
} from '@term/make/code/compile/feed-mill'

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

function grammarOf(text: string): FeedMineGrammar {
  const parsed = parse({ file: 'probe.tree', text })
  if (!parsed.ok) {
    throw new Error('the probe grammar did not parse')
  }
  return readFeedMineGrammar(parsed.tree as RootNode)
}

// a rule outside every repetition and span: its miss reports what it expected, which inside a repetition is a bare
// `halt`, and its `maybe`'s payload is what the maybe sends, which inside a span is the text the maybe consumed
const PLAIN = grammarOf(`mine pair\n  mine char, <a>, send first\n  mine maybe\n    mine char, <b>, send second\n  mine text, <bc>\n`)

// the first line where two texts differ, both sides
function firstDiffer(a: string, b: string): string {
  const x = a.split('\n')
  const y = b.split('\n')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) {
      return `line ${i + 1}: alone ${JSON.stringify(x[i])}, after ${JSON.stringify(y[i])}`
    }
  }
  return 'same'
}

const alone = (): string => compileFeedMine(PLAIN, 'text', '@term/mill/feed')

// a grammar whose compile throws INSIDE a repetition, and one that throws inside a span: a rule call whose argument
// holds no node, read only when the call is written, after the counter is raised (an empty child throws earlier, in
// the capture scan, before any counter moves)
const BAD_CALL = { kind: 'form', name: 'other', args: [{ name: 'a', value: null }] }

const throwing = (kind: 'list' | 'span'): FeedMineGrammar =>
  new Map([
    [
      'broken',
      [
        kind === 'list'
          ? ({ kind: 'list', children: [BAD_CALL] } as unknown as FeedMineRule)
          : ({ kind: 'span', children: [BAD_CALL], send: 'value' } as unknown as FeedMineRule),
      ],
    ],
  ])

const first = alone()
ok('the plain grammar reports what it expected', first.includes('expected'), first)

// the span first, so a counter the list's throw raised cannot stand in for the span's
for (const kind of ['span', 'list'] as const) {
  let threw = false
  try {
    compileFeedMine(throwing(kind), 'text', '@term/mill/feed')
  } catch {
    threw = true
  }
  ok(`a compile throwing inside a ${kind} throws`, threw)
  const after = alone()
  ok(
    `after a throw inside a ${kind}, a compile gives what it gives alone`,
    after === first,
    firstDiffer(first, after),
  )
  // twice over, so a counter raised by one throw and another would show too
  try {
    compileFeedMine(throwing(kind), 'byte', '@term/mill/feed')
  } catch {
    // the throw is the point
  }
  const again = alone()
  ok(`after two throws inside a ${kind}, still the same`, again === first, firstDiffer(first, again))
}

console.log(`\nfeed-state-fresh: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
