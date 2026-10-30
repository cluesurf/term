// compile/parallel-lower.tree `parallel-facts`: what the TypeScript and Rust emitters lift a parallel walk's turn from
// (decision 021 section 12 of note/project/term/self-host/change/001-finish-self-host, decision 011). Three fixtures,
// each checked, stamped by `stamp-places` as an emitter's entry stamps it, and read: a walk with no capture, one with
// three captures and two slots, and two walks of one task (one inside a `fork`, raising two forms). Each fact is
// printed and compared to the one written here; a second compile of the same source gives the same keys and places,
// and the pass leaves the stamped program as it found it. Item term-self-host-001-0233.
// Run: npx tsx test/compile/parallel-lower.ts (from deck/term/deck/term). PARALLEL_LOWER_MODULE=<file> reads another
// build of the module (a draft port)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { stampPlaces } from '@term/make/code/compile/place-stamp'
import { showType } from '@term/make/code/compile/type-text'

type Maybe =
  | { form: 'some'; value: unknown }
  | { form: 'none' }
  | undefined
type Fact = {
  place: number
  key: string
  item: string
  itemType: Maybe
  index: string
  indexType: Maybe
  captures: { name: string; given: Maybe }[]
  slots: { at: number; name: string; element: Maybe }[]
  raises: string[]
}

const loaded = (await (process.env.PARALLEL_LOWER_MODULE
  ? import(process.env.PARALLEL_LOWER_MODULE)
  : import('@term/make/code/compile/parallel-lower'))) as {
  parallelFacts: (program: unknown[]) => Fact[]
}

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

const dir = mkdtempSync(join(tmpdir(), 'term-parallel-lower-'))

const shown = (given: Maybe): string =>
  given && given.form === 'some' ? showType(given.value as never) : '-'

// one fact as a line: key, item and index with their types, captures, numbered slots, raises (the place apart)
const line = (fact: Fact): string =>
  [
    fact.key,
    `item ${fact.item}: ${shown(fact.itemType)}`,
    `index ${fact.index || '-'}: ${shown(fact.indexType)}`,
    `captures [${fact.captures.map(one => `${one.name}: ${shown(one.given)}`).join(', ')}]`,
    `slots [${fact.slots.map(one => `${one.at} ${one.name}: ${shown(one.element)}`).join(', ')}]`,
    `raises [${fact.raises.join(', ')}]`,
  ].join(' | ')

function factsOf(
  name: string,
  text: string,
): { facts: Fact[]; unchanged: boolean } {
  const built = compile({ file: join(dir, `${name}.tree`), text }, {
    resolve: projectResolver(process.cwd(), 'node'),
    env: 'node',
  } as never) as {
    ok: boolean
    program: unknown[]
    diagnostics?: { message: string }[]
  }

  if (!built.ok) {
    throw new Error(
      `${name}: ${(built.diagnostics ?? []).map(d => d.message).join(' | ')}`,
    )
  }

  const stamped = stampPlaces(built.program as never) as unknown[]
  const before = JSON.stringify(stamped)
  const facts = loaded.parallelFacts(stamped)

  return { facts, unchanged: JSON.stringify(stamped) === before }
}

const LIST = `load @term/base/list
  find list
`

const FIXTURES: { name: string; text: string; wanted: string[] }[] = [
  {
    name: 'no-capture',
    text: `${LIST}
task doubled
  take xs, like list, like number
  like list, like number
  save out, make list
  walk xs, mark parallel
    take x
    take at
    save out/{at}, multiply(x, 2)
  back out
`,
    wanted: [
      'doubled#0 | item x: number | index at: number | captures [] | slots [0 out: number] | raises []',
    ],
  },
  {
    name: 'captures-and-slots',
    text: `${LIST}
form pair
  link a, like number
  link b, like text

task shifted
  take xs, like list, like number
  take p, like pair
  take weights, like list, like number
  take scale, like number
  like list, like number
  save low, make list
  save high, make list
  walk xs, mark parallel
    take x
    take at
    save low/{at}, add(x, p/a)
    save high/{at}, multiply(scale, weights/length)
  back high
`,
    wanted: [
      'shifted#0 | item x: number | index at: number | captures [p: pair, scale: number, weights: list, like number] | slots [0 low: number, 1 high: number] | raises []',
    ],
  },
  {
    name: 'in-a-fork',
    text: `${LIST}
load @term/base/exception
  find exception

form upload-excess
  like exception
    bind note, <Upload too large>
    link size, like number

task checked
  take xs, like list, like number
  take limit, like number
  like list, like number
  save out, make list
  fork test, is-above(xs/length, 0)
    hold
      walk xs, mark parallel
        take x
        take at
        fork test, is-above(x, limit)
          hold
            halt upload-excess
              bind size, x
        fork test, is-below(x, 0)
          hold
            halt <below zero>
        save out/{at}, x
  walk xs, mark parallel
    take y
    save nothing, y
  back out
`,
    wanted: [
      'checked#0 | item x: number | index at: number | captures [limit: number] | slots [0 out: number] | raises [failure, upload-excess]',
      'checked#1 | item y: number | index -: - | captures [] | slots [] | raises []',
    ],
  },
]

for (const fixture of FIXTURES) {
  const first = factsOf(fixture.name, fixture.text)
  const lines = first.facts.map(line)
  for (const one of lines) console.log(`      ${one}`)
  ok(
    `${fixture.name}: the facts are the ones written`,
    JSON.stringify(lines) === JSON.stringify(fixture.wanted),
    JSON.stringify(lines),
  )
  ok(
    `${fixture.name}: every walk has a place, and no two share one`,
    first.facts.every(fact => fact.place > 0) &&
      new Set(first.facts.map(fact => fact.place)).size ===
        first.facts.length,
    JSON.stringify(first.facts.map(fact => fact.place)),
  )
  ok(
    `${fixture.name}: the pass writes nothing into the program`,
    first.unchanged,
  )

  const second = factsOf(`${fixture.name}-again`, fixture.text)
  ok(
    `${fixture.name}: a second compile gives the same keys and places`,
    JSON.stringify(second.facts.map(fact => [fact.key, fact.place])) ===
      JSON.stringify(first.facts.map(fact => [fact.key, fact.place])),
  )
}

const none = factsOf(
  'no-walk',
  `${LIST}
task plain
  take xs, like list, like number
  like number
  back xs/length
`,
)
ok(
  'a program with no parallel walk answers no fact',
  none.facts.length === 0,
)

console.log(`\nparallel-lower: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
