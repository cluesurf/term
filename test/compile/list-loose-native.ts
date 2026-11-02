// A LIST OR HASH MADE IN PLACE TAKES THE WANTED TYPE, and a generic value pushed into a list of unknown builds (decision
// note/project/term/compiler/decision/011-a-list-is-invariant-in-a-loose-element.md, step 1 of 3, item
// term-self-host-001-0738). Each program is built and RUN on TypeScript, Rust, Swift and Kotlin, and every backend must
// print the same text.
//
// Held: a list that really mixes its elements, made as an argument, a named argument, a field, a result and a declared
// let, for `unknown` and for `dynamic`; a hash likewise; a list nested in a wanted list; an empty list; and the explicit
// copy the refusal will name, `fix-explicit-copy` of tmp/self-host/0736/fixes.ts, which kotlinc refused. A list of T
// handed to a list of unknown is NOT held here: decision 011 refuses it, in item 0740.
// Run: npx tsx test/compile/list-loose-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin,
// SLOT_CASE=<name>)
// A TypeScript test, not a `term test`: it builds with each native toolchain (P12 port debt, log.md 2026-11-01).

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

const SEEN = `task seen
  take value, like unknown
  like text
  sift value
    case text
      back <t:{value}>
    case number
      back <n:{value}>
    miss
      back <other>

task walked
  take got, like list, like unknown
  like text
  save out, <>
  walk got
    take one
    save said, seen(one)
    save out, <{out}{said} >
  back out

task walked-host
  take got, like list, like dynamic
  like number
  back got/length

task keyed
  take got, like hash, like text, like unknown
  take key, like text
  like text
  back seen(got/{key})

form holder
  link items, like list, like unknown

form keeper
  link items, like hash, like text, like unknown
`

// `gap` names a backend this cannot pass on yet and why: Rust spells `dynamic` serde_json::Value and has no conversion of
// a value into it, so what a list of dynamic holds there waits on its own Decide item (log.md, item 0738). `refused`
// holds that the rule does not reach too far: the program must fail at compile, on every backend.
const CASES: {
  name: string
  body: string
  expected: string
  gap?: Partial<Record<Backend, string>>
  refused?: string
}[] = [
  {
    // a generic parameter wants nothing: the literal keeps its own element
    name: 'list-generic-keeps-its-element',
    expected: 'a',
    body: `task first-of
  head t
  take got, like list, like t
  like t
  back got/0

task run
  like text
  back first-of(make list(<a>, <b>))
`,
  },
  {
    // a concrete element wants no widening: the literal is still held to it
    name: 'list-of-text-refuses-a-number',
    expected: '',
    refused: 'array element',
    body: `task texts
  take got, like list, like text
  like number
  back got/length

task run
  like text
  back <{texts(make list(<a>, 1))}>
`,
  },
  {
    name: 'list-argument',
    expected: 't:a n:1 ',
    body: `task run
  like text
  save id, <a>
  back walked(make list(id, 1))
`,
  },
  {
    name: 'list-named-argument',
    expected: 't:a n:1 ',
    body: `task run
  like text
  save said
    call walked
      bind got, make list(<a>, 1)
  back said
`,
  },
  {
    name: 'list-field',
    expected: 't:a n:1 ',
    body: `task run
  like text
  save h
    make holder
      bind items, make list(<a>, 1)
  back walked(h/items)
`,
  },
  {
    name: 'list-result',
    expected: 't:a n:1 ',
    body: `task handed
  like list, like unknown
  back make list(<a>, 1)

task run
  like text
  back walked(handed())
`,
  },
  {
    name: 'list-declared-let',
    expected: 't:a n:1 ',
    body: `task run
  like text
  save xs
    like list, like unknown
    make list(<a>, 1)
  back walked(xs)
`,
  },
  {
    // every element of one type still boxes: the wanted type wins over the elements'
    name: 'list-one-element-type',
    expected: 't:a t:b ',
    body: `task run
  like text
  back walked(make list(<a>, <b>))
`,
  },
  {
    name: 'list-empty-then-pushed-by-callee',
    expected: 'n:7 ',
    body: `task with-seven
  take got, like list, like unknown
  like text
  got/push(7)
  back walked(got)

task run
  like text
  back with-seven(make list)
`,
  },
  {
    name: 'list-dynamic-argument',
    expected: '2',
    gap: { rust: 'dynamic is serde_json::Value on Rust, and no value converts into it' },
    body: `task run
  like text
  back <{walked-host(make list(<a>, 1))}>
`,
  },
  {
    name: 'list-nested',
    expected: '2 t:a n:1 ',
    body: `task deep
  take got, like list, like list, like unknown
  like text
  save first, got/0
  back <{first/length} {walked(first)}>

task run
  like text
  back deep(make list(make list(<a>, 1)))
`,
  },
  {
    name: 'hash-argument',
    expected: 'n:1',
    body: `task run
  like text
  save made
    call keyed
      make hash
        save <a>, <b>
        save <c>, 1
      text <c>
  back made
`,
  },
  {
    name: 'hash-field',
    expected: 'n:1',
    body: `task run
  like text
  save h
    make keeper
      bind items
        make hash
          save <a>, <b>
          save <c>, 1
  back keyed(h/items, <c>)
`,
  },
  {
    name: 'hash-result',
    expected: 't:b',
    body: `task handed
  like hash, like text, like unknown
  back
    make hash
      save <a>, <b>
      save <c>, 1

task run
  like text
  back keyed(handed(), <a>)
`,
  },
  {
    name: 'hash-declared-let',
    expected: 'n:1',
    body: `task run
  like text
  save xs
    like hash, like text, like unknown
    make hash
      save <a>, <b>
      save <c>, 1
  back keyed(xs, <c>)
`,
  },
  {
    // the way out decision 011 names for a boxed list from a list of T: copied by name. kotlinc refused `T` where `Any`
    // is wanted
    name: 'explicit-copy',
    expected: 't:a ',
    body: `task texts-made
  like list, like text
  save out, make list
  out/push(<a>)
  back out

task boxed-all
  head t
  take got, like list, like t
  like list, like unknown
  save out, make list
  walk got
    take one
    out/push(one)
  back out

task run
  like text
  back walked(boxed-all(texts-made()))
`,
  },
  {
    name: 'explicit-copy-numbers',
    expected: 'n:7 ',
    body: `task boxed-all
  head t
  take got, like list, like t
  like list, like unknown
  save out
    like list, like unknown
    make list
  walk got
    take one
    out/push(one)
  back out

task run
  like text
  save ns, make list
  ns/push(7)
  back walked(boxed-all(ns))
`,
  },
]

const dir = mkdtempSync(join(tmpdir(), 'list-loose-'))
const only = process.env.SLOT_ONLY ?? ''
const caseOnly = process.env.SLOT_CASE ?? ''
let pass = 0
let fail = 0
let skipped = 0

for (const one of CASES.filter(c => !caseOnly || c.name === caseOnly)) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const gap = one.gap?.[backend]

    if (gap) {
      skipped++
      console.log(`gap   ${one.name} ${backend}: ${gap}`)
      continue
    }

    const ran = runOn({
      backend,
      program: `${SEEN}\n${one.body}`,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: `l-${one.name}`,
    })

    if (ran.form === 'skipped') {
      skipped++
      console.log(`skip  ${one.name} ${backend}: ${ran.reason}`)
    } else if (one.refused) {
      if (ran.form === 'failed' && ran.stage === 'compile' && ran.reason.includes(one.refused)) {
        pass++
        console.log(`ok    ${one.name} ${backend}`)
      } else {
        fail++
        console.log(`FAIL  ${one.name} ${backend}: not refused for ${one.refused}: ${JSON.stringify(ran)}`)
      }
    } else if (ran.form === 'ran' && ran.output === one.expected) {
      pass++
      console.log(`ok    ${one.name} ${backend}`)
    } else {
      fail++
      console.log(
        `FAIL  ${one.name} ${backend}: ${ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 400)}`}`,
      )
    }
  }
}

console.log(`list-loose-native: ${pass} pass, ${fail} fail, ${skipped} skipped`)

if (fail > 0) {
  process.exit(1)
}
