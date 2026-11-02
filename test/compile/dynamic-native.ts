// `dynamic` IS THE BOXED DYNAMIC ON EVERY BACKEND (decision note/project/term/compiler/decision/011, "What dynamic is on
// Rust", item term-self-host-001-0763). Each program is built and RUN on TypeScript, Rust, Swift and Kotlin, and every
// backend must print the same text.
//
// Held: a value entering a dynamic place (an argument, a declared let, a field, a list, a hash), rule 3 of the decision in
// both directions with a callee's push seen by its caller, a JSON scalar being the Term value, and is-equal of loose values
// held and inlined. Not here: a member read off a loose value and a record out of one by `back`, Decide 0765. A case with
// a `gap` names the item holding that backend's own defect, which predates this.
// Run: npx tsx test/compile/dynamic-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin,
// SLOT_CASE=<name>)
// A TypeScript test, not a `term test`: it builds with each native toolchain (P12 port debt, log.md item 0763).

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

const SEEN = `load @term/base/json
  find parse
  find stringify
  find get-field
  find as-text
  find as-number

task seen
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

task counted
  take got, like list, like dynamic
  like number
  back got/length

task pass-on
  take value, like dynamic
  like dynamic
  back value

task pass-unknown
  take value, like unknown
  like unknown
  back value

form box-of
  link held, like dynamic

form holder
  link items, like list, like dynamic

form user
  link name, like text
`

const SWIFT_EQUAL = '0764: is-equal of two loose values fails swiftc'
const KOTLIN_NUMBER = '0764: a JSON number reads as neither text nor number in sift on Kotlin'

const CASES: {
  name: string
  body: string
  expected: string
  gap?: Partial<Record<Backend, string>>
}[] = [
  {
    name: 'list-argument',
    expected: '2',
    body: `task run
  like text
  back <{counted(make list(<a>, 1))}>
`,
  },
  {
    name: 'value-into-dynamic-text',
    expected: 't:a',
    body: `task run
  like text
  back seen(pass-on(<a>))
`,
  },
  {
    name: 'value-into-dynamic-number',
    expected: 'n:7',
    body: `task run
  like text
  back seen(pass-on(7))
`,
  },
  {
    name: 'declared-let',
    expected: 't:a',
    body: `task run
  like text
  save x
    like dynamic
    text <a>
  back seen(x)
`,
  },
  {
    name: 'dynamic-back-to-text',
    expected: 'a',
    body: `task run
  like text
  save x, pass-on(<a>)
  save s
    like text
    read x
  back s
`,
  },
  {
    name: 'field-holds-value',
    expected: 't:a',
    body: `task run
  like text
  save b
    make box-of
      bind held, <a>
  back seen(b/held)
`,
  },
  {
    name: 'list-field',
    expected: '2',
    body: `task run
  like text
  save h
    make holder
      bind items, make list(<a>, 1)
  back <{counted(h/items)}>
`,
  },
  {
    name: 'rule-3-dynamic-to-unknown',
    expected: 't:a n:1 ',
    body: `task made
  like list, like dynamic
  back make list(<a>, 1)

task run
  like text
  back walked(made())
`,
  },
  {
    name: 'rule-3-aliases',
    expected: '3',
    body: `task grown
  take got, like list, like unknown
  got/push(<c>)

task run
  like text
  save xs
    like list, like dynamic
    make list(<a>, 1)
  grown(xs)
  back <{xs/length}>
`,
  },
  {
    name: 'rule-3-unknown-to-dynamic',
    expected: '2',
    body: `task made
  like list, like unknown
  back make list(<a>, 1)

task run
  like text
  back <{counted(made())}>
`,
  },
  {
    name: 'empty-then-push',
    expected: '1',
    body: `task run
  like text
  save xs
    like list, like dynamic
    make list
  xs/push(<a>)
  back <{counted(xs)}>
`,
  },
  {
    name: 'hash-of-dynamic',
    expected: 't:b',
    body: `task keyed
  take got, like hash, like text, like dynamic
  take key, like text
  like text
  back seen(got/{key})

task run
  like text
  save xs
    like hash, like text, like dynamic
    make hash
      save <a>, <b>
      save <c>, 1
  back keyed(xs, <a>)
`,
  },
  {
    // the generic deep_equal: an identity task inlined away leaves a concrete value here
    name: 'equal-dynamic-values',
    expected: 'true',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  back <{is-equal(pass-on(<a>), pass-on(<a>))}>
`,
  },
  {
    name: 'equal-unknown-values',
    expected: 'true',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  back <{is-equal(pass-unknown(<a>), pass-unknown(<a>))}>
`,
  },
  {
    // an integer an inlined identity leaves bare is an i32 to rustc until something pins it
    name: 'equal-inlined-numbers',
    expected: 'true false true',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  back <{is-equal(pass-on(1), pass-on(1))} {is-equal(pass-on(1), pass-on(2))} {is-unequal(pass-on(1), pass-on(2))}>
`,
  },
  {
    name: 'equal-loose-against-text',
    expected: 'true false',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  back <{is-equal(pass-on(<a>), <a>)} {is-equal(pass-on(<a>), <b>)}>
`,
  },
  {
    // the operands are cloned: a name stays readable after it is compared
    name: 'equal-name-read-after',
    expected: 'true t:a',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  save x, pass-on(<a>)
  save y, pass-on(<a>)
  save same, is-equal(x, y)
  back <{same} {seen(x)}>
`,
  },
  {
    name: 'equal-json-values',
    expected: 'true',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  back <{is-equal(parse(<1>), parse(<1>))}>
`,
  },
  {
    name: 'equal-held-unknown',
    expected: 'true false',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  save got
    like list, like unknown
    make list(<a>, <a>, 1)
  back <{is-equal(got/0, got/1)} {is-equal(got/0, got/2)}>
`,
  },
  {
    name: 'equal-held-dynamic',
    expected: 'true false',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  save got
    like list, like dynamic
    make list(<a>, <a>, 1)
  back <{is-equal(got/0, got/1)} {is-equal(got/0, got/2)}>
`,
  },
  {
    name: 'equal-held-lists',
    expected: 'true true',
    gap: { swift: SWIFT_EQUAL },
    body: `task run
  like text
  save xs, make list(<a>)
  save ys, make list(<a>)
  save got
    like list, like dynamic
    make list(xs, xs, ys)
  back <{is-equal(got/0, got/1)} {is-equal(got/0, got/2)}>
`,
  },
  {
    name: 'json-accessors',
    expected: 'a 2 {"x":"a","y":2}',
    body: `task run
  like text
  save v, parse(<\\{"x":"a","y":2\\}>)
  back <{as-text(get-field(v, <x>))} {as-number(get-field(v, <y>))} {stringify(v)}>
`,
  },
  {
    name: 'json-text-is-a-text',
    expected: 't:a',
    body: `task run
  like text
  back seen(parse(<"a">))
`,
  },
  {
    name: 'json-number-is-a-number',
    expected: 'n:7',
    gap: { kotlin: KOTLIN_NUMBER },
    body: `task run
  like text
  back seen(parse(<7>))
`,
  },
  {
    name: 'json-field-is-a-text',
    expected: 't:a',
    body: `task run
  like text
  back seen(get-field(parse(<\\{"x":"a"\\}>), <x>))
`,
  },
  {
    name: 'json-bound-as-text',
    expected: 'a',
    body: `task run
  like text
  save s
    like text
    call parse
      text <"a">
  back s
`,
  },
  {
    name: 'json-in-a-list-of-dynamic',
    expected: '2',
    body: `task run
  like text
  back <{counted(make list(parse(<1>), <a>))}>
`,
  },
  {
    name: 'value-handed-to-stringify',
    expected: '"a"',
    body: `task run
  like text
  back stringify(<a>)
`,
  },
]

// a shim docked by a module and linked by the emitter goes in once, and with no dock it goes in all the same
const RUST_ONLY: { name: string; body: string; expected: string }[] = [
  {
    name: 'link-with-a-dock-too',
    expected: 'true true',
    body: `dock load
  load <global:compare>, name compare-runtime

task run
  like text
  back <{is-equal(pass-on(<a>), pass-on(<a>))} {compare-runtime/deep-equal(<a>, <a>)}>
`,
  },
  {
    // what a box hides is equal only to itself, never to all others
    name: 'held-records-are-told-apart',
    expected: 'true false',
    body: `task run
  like text
  save a
    make user
      bind name, <a>
  save b
    make user
      bind name, <b>
  save got
    like list, like dynamic
    make list(a, b)
  save first, got/0
  back <{is-equal(first, first)} {is-equal(got/0, got/1)}>
`,
  },
]

const root = mkdtempSync(join(tmpdir(), 'dynamic-native-'))
process.on('exit', () => rmSync(root, { recursive: true, force: true }))
const dir = join(root, 'out')
mkdirSync(dir, { recursive: true })
const only = process.env.SLOT_ONLY ?? ''
const caseOnly = process.env.SLOT_CASE ?? ''
let pass = 0
let fail = 0
let skipped = 0

function hold(name: string, backend: Backend, body: string, expected: string) {
  const ran = runOn({
    backend,
    program: `${SEEN}\n${body}`,
    resolve: env => projectResolver(process.cwd(), env),
    dir,
    name: `d-${name}`,
  })

  if (ran.form === 'skipped') {
    skipped++
    console.log(`skip  ${name} ${backend}: ${ran.reason}`)
  } else if (ran.form === 'ran' && ran.output === expected) {
    pass++
    console.log(`ok    ${name} ${backend}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name} ${backend}: ${ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason.slice(0, 500)}`}`,
    )
  }
}

for (const one of CASES.filter(c => !caseOnly || c.name === caseOnly)) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const gap = one.gap?.[backend]

    if (gap) {
      skipped++
      console.log(`gap   ${one.name} ${backend}: ${gap}`)
      continue
    }

    hold(one.name, backend, one.body, one.expected)
  }
}

if (!only || only === 'rust') {
  for (const one of RUST_ONLY.filter(c => !caseOnly || c.name === caseOnly)) {
    hold(one.name, 'rust', one.body, one.expected)
  }
}

console.log(`dynamic-native: ${pass} pass, ${fail} fail, ${skipped} skipped`)

if (fail > 0) {
  process.exit(1)
}
