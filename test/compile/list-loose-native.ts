// A LIST OR HASH MADE IN PLACE TAKES THE WANTED TYPE, and a generic value pushed into a list of unknown builds (decision
// note/project/term/compiler/decision/011-a-list-is-invariant-in-a-loose-element.md, step 1 of 3, item
// term-self-host-001-0738). Each program is built and RUN on TypeScript, Rust, Swift and Kotlin, and every backend must
// print the same text.
//
// Held: a list that really mixes its elements, made as an argument, a named argument, a field, a result and a declared
// let, for `unknown` and for `dynamic`; a hash likewise; a list nested in a wanted list; an empty list; and the explicit
// copy the refusal names, `fix-explicit-copy` of tmp/self-host/0736/fixes.ts, which kotlinc refused.
//
// THE REFUSAL, step 3, item 0740: a list, a hash or a form type argument with a loose element on one side only, the other
// settled, in either direction, is refused by the checker on every backend, so no native compiler is the one to say so.
// Every program of the 0541 probe (tmp/self-host/0541/probe.ts, 27 pass 41 fail before) either runs or is refused here,
// each generic way out runs, and rule 3 holds: a list of unknown and a list of dynamic meet in both directions and a
// callee's push is seen.
// Run: npx tsx test/compile/list-loose-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin,
// SLOT_CASE=<name>)
// A TypeScript test, not a `term test`: it builds with each native toolchain (P12 port debt, log.md 2026-11-01).

import { projectResolver } from '@term/call/code/make'
import { tempDir } from '../temp'
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

// the callees of the 0541 probe and decision 011's rule 3
const PROBE = `task two-of
  take got, like list, like unknown
  like text
  back <{got/length} {seen(got/0)}>

task texts-made
  like list, like text
  save out, make list
  out/push(<a>)
  back out

task extended
  take got, like list, like unknown
  like list, like unknown
  save more, got
  more/push(1)
  back more

task pushed-text
  take got, like list, like text
  like list, like text
  save more, got
  more/push(<b>)
  back more

task deep
  take got, like list, like list, like unknown
  like number
  back got/length

form parcel
  head t
  link item, like t
`

// what every refusal of a loose element says
const CLASH = 'does not fit one holding a settled type'

const refused = (name: string, body: string) => ({
  name,
  expected: '',
  refused: CLASH,
  body: `${PROBE}\n${body}`,
})

const runs = (name: string, expected: string, body: string) => ({
  name,
  expected,
  body: `${PROBE}\n${body}`,
})

// `gap` names a backend this cannot pass on yet and why. `refused` holds that the rule does not reach too far: the program
// must fail at compile, on every backend.
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
  // the 0541 probe, every shape of a list of T meeting a list of unknown
  refused('probe-pushed-local-to-small-param', `task run
  like text
  save xs, make list
  xs/push(<a>)
  back two-of(xs)
`),
  refused('probe-pushed-local-to-walking-param', `task run
  like text
  save xs, make list
  xs/push(<a>)
  back walked(xs)
`),
  refused('probe-declared-text-to-param', `task run
  like text
  save xs, texts-made()
  back walked(xs)
`),
  refused('probe-call-result-to-small-param', `task run
  like text
  back two-of(texts-made())
`),
  refused('probe-call-result-to-walking-param', `task run
  like text
  back walked(texts-made())
`),
  refused('probe-pushed-local-to-field', `task run
  like text
  save xs, make list
  xs/push(<a>)
  save h
    make holder
      bind items, xs
  back walked(h/items)
`),
  refused('probe-declared-text-to-field', `task run
  like text
  save h
    make holder
      bind items, texts-made()
  back walked(h/items)
`),
  refused('probe-field-write', `task run
  like text
  save first
    like list, like unknown
    make list
  save h
    make holder
      bind items, first
  save xs, texts-made()
  save h/items, xs
  back walked(h/items)
`),
  refused('probe-returned-non-empty-local', `task handed
  like list, like unknown
  save xs, texts-made()
  back xs

task run
  like text
  back walked(handed())
`),
  refused('probe-declared-let', `task run
  like text
  save ys
    like list, like unknown
    call texts-made
  back walked(ys)
`),
  refused('probe-keeps-its-own-type', `task run
  like text
  save xs, make list
  xs/push(<a>)
  save said, walked(xs)
  save first, xs/0
  back <{said} {first}>
`),
  refused('probe-number-list', `task run
  like text
  save xs, make list
  xs/push(7)
  back walked(xs)
`),
  refused('probe-callee-extends-and-hands-back', `task run
  like text
  save xs, make list
  xs/push(<a>)
  back walked(extended(xs))
`),
  refused('probe-caller-reads-after-callee-extends', `task run
  like text
  save xs, make list
  xs/push(<a>)
  save ys, extended(xs)
  back <{xs/length}>
`),
  refused('probe-list-of-list', `task run
  like text
  save xs, make list
  xs/push(texts-made())
  back <{deep(xs)}>
`),
  refused('probe-hash-of-unknown', `task run
  like text
  save xs
    make hash
      save <a>, <b>
  back keyed(xs, <a>)
`),
  // a list has one identity: a callee's push is seen by its caller
  runs('probe-baseline-callee-extends-caller-length', '2', `task run
  like text
  save xs, make list
  xs/push(<a>)
  save ys, pushed-text(xs)
  back <{xs/length}>
`),
  // the other direction, and dynamic, and a form's type argument
  refused('refused-unknown-into-text', `task loose-made
  like list, like unknown
  back make list(<a>, 1)

task count-texts
  take got, like list, like text
  like number
  back got/length

task run
  like text
  back <{count-texts(loose-made())}>
`),
  refused('refused-text-into-dynamic', `task run
  like text
  back <{walked-host(texts-made())}>
`),
  refused('refused-dynamic-into-text', `task loose-made
  like list, like dynamic
  back make list(<a>, 1)

task count-texts
  take got, like list, like text
  like number
  back got/length

task run
  like text
  back <{count-texts(loose-made())}>
`),
  refused('refused-hash-value-dynamic', `task keyed-host
  take got, like hash, like text, like dynamic
  like number
  back got/size

task run
  like text
  save xs
    make hash
      save <a>, <b>
  back <{keyed-host(xs)}>
`),
  refused('refused-form-argument', `task open-box
  take got, like parcel, like unknown
  like text
  back seen(got/item)

task run
  like text
  save held
    like parcel, like text
    make parcel
      bind item, <a>
  back open-box(held)
`),
  refused('refused-form-argument-in-list', `task open-boxes
  take got, like list, like parcel, like dynamic
  like number
  back got/length

task run
  like text
  save held
    like parcel, like text
    make parcel
      bind item, <a>
  save all, make list
  all/push(held)
  back <{open-boxes(all)}>
`),
  // a literal the wanted type does not reach infers itself, so one of a single type is a list of T: decision 011 rule 1
  // names an argument, a field, a result and a declared let, and an assignment is none of them
  refused('refused-assigned-literal', `task run
  like text
  save h
    make holder
      bind items, make list(<z>, 1)
  save h/items, make list(<a>, <b>)
  back walked(h/items)
`),
  // an overload picks by fit, and agrees with the unifier: only the exact member fits
  runs('overload-picks-the-exact-list', 'text', `task pick
  take got, like list, like unknown
  like text
  back <loose>

task pick
  take got, like list, like text
  like text
  back <text>

task run
  like text
  back pick(texts-made())
`),
  refused('overload-no-member-fits', `task pick
  take got, like list, like unknown
  like text
  back <loose>

task pick
  take got, like list, like number
  take more, like number, fall 0
  like text
  back <number>

task run
  like text
  back pick(texts-made())
`),
  // a word not yet pinned takes the wanted element, and later pushes box (rule 2)
  runs('variable-still-binds', 't:a n:1 ', `task run
  like text
  save xs, make list
  save said, walked(xs)
  xs/push(<a>)
  xs/push(1)
  back walked(xs)
`),
  // rule 3: two loose words meet, in both directions, and a callee's push is seen
  runs('rule-3-dynamic-to-unknown', 't:a n:1 ', `task made
  like list, like dynamic
  back make list(<a>, 1)

task run
  like text
  back walked(made())
`),
  runs('rule-3-aliases', '3', `task grown
  take got, like list, like unknown
  got/push(<c>)

task run
  like text
  save xs
    like list, like dynamic
    make list(<a>, 1)
  grown(xs)
  back <{xs/length}>
`),
  runs('rule-3-unknown-to-dynamic', '2', `task made
  like list, like unknown
  back make list(<a>, 1)

task run
  like text
  back <{walked-host(made())}>
`),
  runs('rule-3-aliases-back', '3', `task grown
  take got, like list, like dynamic
  got/push(<c>)

task run
  like text
  save xs
    like list, like unknown
    make list(<a>, 1)
  grown(xs)
  back <{xs/length}>
`),
  runs('rule-3-hash', 'n:1', `task keyed-host
  take got, like hash, like text, like dynamic
  like number
  back got/size

task made
  like hash, like text, like unknown
  back
    make hash
      save <c>, 1

task run
  like text
  save xs, made()
  save size, keyed-host(xs)
  back seen(size)
`),
  // the first way out: a generic callee takes the list as it is, and a push is seen
  runs('way-out-generic', '1 t:a', `task two-of-any
  head t
  take got, like list, like t
  like text
  save first, got/0
  back <{got/length} {seen(first)}>

task run
  like text
  back two-of-any(texts-made())
`),
  runs('way-out-generic-aliases', '2', `task doubled
  head t
  take got, like list, like t
  got/push(got/0)

task run
  like text
  save xs, texts-made()
  doubled(xs)
  back <{xs/length}>
`),
  // a generic callee does not get past the rule by handing its list on
  refused('generic-handed-on-is-refused', `task handed-on
  head t
  take got, like list, like t
  like text
  back walked(got)

task run
  like text
  back handed-on(texts-made())
`),
  // the second way out: declared from its first line
  runs('way-out-declared', 't:a n:1 ', `task run
  like text
  save xs
    like list, like unknown
    make list
  xs/push(<a>)
  xs/push(1)
  back walked(xs)
`),
]

const dir = tempDir('list-loose-')
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
