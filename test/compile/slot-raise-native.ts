// A CALLBACK'S RAISE MEANS ONE THING ON EVERY BACKEND (decisions 086 rule 4, 089 rule 5 and 092 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0464). The checker charges a
// pass-through parameter's raise to the caller (0463). Here each shape is built and RUN on TypeScript, Rust, Swift and
// Kotlin, and every backend must print what TypeScript prints. Before 0464 Rust failed E0271 or E0308 on the cm-0012
// shape (a raising task boxed as a future of its plain answer), and Swift on the closure types.
//
// Held: the cm-0012 shape (hand calls handler, run calls hand with a raising dispatch inside a guard that prints the
// caught form) and the same through a forwarding outer; a sync pass-through slot; sort with a raising and an
// infallible comparator (the infallible call's Rust text unchanged: the plain instance); a closed slot declared
// `halt failure` holding a raising async task and an infallible one; a value-position tick of a raising task waited in
// a guard, the same through spawn and through gather of a local list of closures, and map-concurrent with a raising
// worker. Also a callee an inlined task leaves as a closure (item 0531) and a list declared of unknown filled every way,
// through inlined identity tasks, by a folded `vec!` and by later pushes (item 0532).
// Run: npx tsx test/compile/slot-raise-native.ts   (from deck/term/deck/term; SLOT_ONLY=typescript|rust|swift|kotlin)
// A TypeScript test, not a `term test`: it builds with each native toolchain (P12 port debt, log.md 2026-11-01).

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { BACKENDS, runOn } from './shared/run-on'

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

const RAISERS = `load @term/base/exception
  find conflict

task dispatch
  mark async
  take message, like text
  like text
  fork test, is-equal(message, <>)
    hold
      halt conflict
        bind thing, <message>
  back message

task echo
  mark async
  take message, like text
  like text
  back message
`

// the cm-0012 shape, and a forwarding outer
const PASSED = `${RAISERS}
task hand
  mark async
  take handler
    like task
      wait true
      take message, like text
      like text
  take message, like text
  like text
  back handler(message)

task outer
  mark async
  take given
    like task
      wait true
      take message, like text
      like text
  take message, like text
  like text
  back hand(given, message)

task caught
  mark async
  take message, like text
  like text
  save answer, <>
  fork
    mark unsafe
    save answer, hand(dispatch, message)
  halt take
    take problem
    save answer, <caught {problem/form}>
  back answer

task forwarded
  mark async
  take message, like text
  like text
  save answer, <>
  fork
    mark unsafe
    save answer, outer(dispatch, message)
  halt take
    take problem
    save answer, <forwarded {problem/form}>
  back answer

task run
  mark async
  like text
  save a, caught(<>)
  save b, caught(<hi>)
  save c, hand(echo, <plain>)
  save d, forwarded(<>)
  save e, outer(echo, <out>)
  back <{a}|{b}|{c}|{d}|{e}>
`

// a sync pass-through slot, and sort with a raising and an infallible comparator
const SYNC = `load @term/base/list
  find list
  find sort

load @term/base/ordering
  find ordering

load @term/base/exception
  find conflict

task checked
  take x, like number
  like number
  fork test, is-below(x, 0)
    hold
      halt conflict
        bind thing, <negative>
  back add(x, 1)

task double
  take x, like number
  like number
  back multiply(x, 2)

task apply
  take f
    like task
      take x, like number
      like number
  take x, like number
  like number
  back f(x)

task by-value
  take left, like number
  take right, like number
  like ordering
  fork test, is-below(left, right)
    hold
      back make less
  fork test, is-above(left, right)
    hold
      back make greater
  back make equal

task by-value-checked
  take left, like number
  take right, like number
  like ordering
  fork test, is-equal(left, 7)
    hold
      halt conflict
        bind thing, <seven>
  back by-value(left, right)

task numbers
  take extra, like number
  like list, like number
  save xs, make list
  xs/push(3)
  xs/push(1)
  xs/push(extra)
  xs/push(2)
  back xs

task applied
  take x, like number
  like text
  save answer, <>
  fork
    mark unsafe
    save answer, <{apply(checked, x)}>
  halt take
    take problem
    save answer, <applied {problem/form}>
  back answer

task sorted
  take extra, like number
  like text
  save answer, <>
  fork
    mark unsafe
    save got, sort(numbers(extra), by-value-checked)
    save answer, <{got/0} {got/3}>
  halt take
    take problem
    save answer, <sorted {problem/form}>
  back answer

task run
  like text
  save plain, sort(numbers(0), by-value)
  back <{apply(double, 4)}|{applied(1)}|{applied(-1)}|{plain/0} {plain/3}|{sorted(5)}|{sorted(7)}>
`

// a closed slot that declares its set, holding a raising async task and an infallible one
const CLOSED = `form holder
  link work
    like task
      wait true
      take message, like text
      like text
      halt failure

task boom
  mark async
  take message, like text
  like text
  fork test, is-equal(message, <>)
    hold
      halt <empty>
  back message

task quiet
  mark async
  take message, like text
  like text
  back message

task use
  mark async
  take given, like holder
  take message, like text
  like text
  save answer, <>
  fork
    mark unsafe
    save answer, given/work(message)
  halt take
    take problem
    save answer, <used {problem/form}>
  back answer

task run
  mark async
  like text
  save loud, make(holder, bind(work, boom))
  save calm, make(holder, bind(work, quiet))
  save a, use(loud, <>)
  save b, use(loud, <x>)
  save c, use(calm, <>)
  back <{a}|{b}|{c}.>
`

// a job raises where its maker waits it (decision 092)
const JOBS = `load @term/base/task
  find handle
  find spawn
  find gather

${RAISERS}
task ticked
  mark async
  take x, like text
  like text
  save answer, <>
  save work, tick dispatch(x)
  fork
    mark unsafe
    save answer, work/wait()
  halt take
    take problem
    save answer, <ticked {problem/form}>
  back answer

task spawned
  mark async
  take x, like text
  like text
  save answer, <>
  save work
    spawn
      task
        mark async
        like text
        back dispatch(x)
  fork
    mark unsafe
    save answer, work/wait()
  halt take
    take problem
    save answer, <spawned {problem/form}>
  back answer

task gathered
  mark async
  take x, like text
  like text
  save answer, <>
  save works, make list
  save one
    task
      mark async
      like text
      back echo(<g>)
  save two
    task
      mark async
      like text
      back dispatch(x)
  works/push(one)
  works/push(two)
  fork
    mark unsafe
    save got, gather(works)
    save answer, <{got/0}{got/1}>
  halt take
    take problem
    save answer, <gathered {problem/form}>
  back answer

task run
  mark async
  like text
  save a, ticked(<>)
  save b, ticked(<t>)
  save c, spawned(<>)
  save d, spawned(<s>)
  save e, gathered(<>)
  save f, gathered(<h>)
  back <{a}|{b}|{c}|{d}|{e}|{f}>
`

// map-concurrent with a raising worker: the worker passes through the lane job (decision 092 rule 7)
const MAP = `load @term/test/concurrency
  find map-concurrent

load @term/base/exception
  find conflict

task risky
  mark async
  take item, like unknown
  take index, like number
  like unknown
  fork test, is-equal(index, 1)
    hold
      halt conflict
        bind thing, <lane>
  back item

task boxed
  take value, like unknown
  like unknown
  back value

task items-of
  like list, like unknown
  save items, make list
  items/push(boxed(<a>))
  items/push(boxed(<b>))
  items/push(boxed(<c>))
  back items

task mapped
  mark async
  like text
  save answer, <>
  fork
    mark unsafe
    save got, map-concurrent(items-of(), risky, 2)
    save answer, <mapped {got/length}>
  halt take
    take problem
    save answer, <mapped {problem/form}>
  back answer

task run
  mark async
  like text
  back mapped()
`

// a closure written at the call: its raise leaves through the slot, sync and async, and one the closure guards stays in it
const CLOSURES = `${RAISERS}
task call-with
  take f
    like task
      take x, like number
      like number
  take x, like number
  like number
  back f(x)

task hand
  mark async
  take handler
    like task
      wait true
      take message, like text
      like text
  take message, like text
  like text
  back handler(message)

task sync-closure
  take x, like number
  like text
  save answer, <>
  fork
    mark unsafe
    save got
      call-with
        task
          take y, like number
          like number
          fork test, is-below(y, 0)
            hold
              halt conflict
                bind thing, <below>
          back add(y, 1)
        read x
    save answer, <{got}>
  halt take
    take problem
    save answer, <sync {problem/form}>
  back answer

task async-closure
  mark async
  take x, like text
  like text
  save answer, <>
  fork
    mark unsafe
    save got
      hand
        task
          mark async
          take message, like text
          like text
          back dispatch(message)
        read x
    save answer, got
  halt take
    take problem
    save answer, <async {problem/form}>
  back answer

task checked
  take y, like number
  like number
  fork test, is-below(y, 0)
    hold
      halt conflict
        bind thing, <below>
  back y

task called-closure
  take x, like number
  like text
  save answer, <>
  fork
    mark unsafe
    save got
      call-with
        task
          take y, like number
          like number
          back checked(y)
        read x
    save answer, <{got}>
  halt take
    take problem
    save answer, <called {problem/form}>
  back answer

task run
  mark async
  like text
  save a, sync-closure(1)
  save b, sync-closure(-1)
  save c, async-closure(<c>)
  save d, async-closure(<>)
  save e, called-closure(3)
  save f, called-closure(-3)
  back <{a}|{b}|{c}|{d}|{e}|{f}>
`

const PLAIN_SORT = `load @term/base/list
  find list
  find sort

load @term/base/ordering
  find ordering

task by-value
  take left, like number
  take right, like number
  like ordering
  fork test, is-below(left, right)
    hold
      back make less
  fork test, is-above(left, right)
    hold
      back make greater
  back make equal

task run
  like text
  save xs, make list
  xs/push(2)
  xs/push(1)
  save got, sort(xs, by-value)
  back <{got/0}>
`

// an inlined task can leave a closure as the callee (item 0531): TypeScript wrote `(y) => {...}(x)`, Kotlin an untyped
// lambda called at once
const APPLY = `task apply
  take f
    like task
      take y, like number
      like number
  take x, like number
  like number
  back f(x)
`

const CLOSURE_CALLEE = `${APPLY}
task run
  like text
  save one
    apply
      task
        take y, like number
        like number
        back add(y, 1)
      code 4
  save two
    apply
      task
        take y, like number
        like number
        save z, add(y, 1)
        back add(z, 1)
      code 4
  back <{one} {two}>
`

// reads a value back out of its box by its type, so a list that holds the wrong thing fails at run as well as at the build
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
`

// a list declared of unknown holds boxed values on every backend (item 0532), by every way of filling it
const UNKNOWN_LISTS = `${SEEN}
task boxed
  take value, like unknown
  like unknown
  back value

task folded
  like list, like unknown
  save items, make list
  items/push(boxed(<a>))
  items/push(boxed(<b>))
  back items

task direct
  like list, like unknown
  save items, make list
  items/push(<a>)
  items/push(<b>)
  back items

task mixed
  like list, like unknown
  save items, make list
  items/push(<a>)
  items/push(1)
  back items

task later
  take more, like text
  like list, like unknown
  save items, make list
  items/push(<a>)
  fork test, is-unequal(more, <>)
    hold
      items/push(more)
      items/push(boxed(more))
  back items

task nested
  take more, like text
  like list, like unknown
  save items, make list
  fork test, is-equal(more, <>)
    hold
      back items
  items/push(more)
  back items

task counted
  like list, like unknown
  save items, make list
  save size, items/push(<a>)
  items/push(size)
  back items

task free
  like number
  save items, make list
  items/push(boxed(<a>))
  back items/length

task two-of
  take got, like list, like unknown
  like text
  back <{got/length} {seen(got/0)} {seen(got/1)}>

task run
  like text
  save a, two-of(folded())
  save b, two-of(direct())
  save c, two-of(mixed())
  save d, two-of(later(<b>))
  save e, nested(<z>)
  save f, two-of(counted())
  back <{a}|{b}|{c}|{d}|{e/length}|{f}|{free()}>
`

const CASES: { name: string; program: string; expected: string }[] = [
  {
    name: 'closure-callee',
    program: CLOSURE_CALLEE,
    expected: '5 6',
  },
  {
    name: 'unknown-lists',
    program: UNKNOWN_LISTS,
    expected:
      '2 t:a t:b|2 t:a t:b|2 t:a n:1|3 t:a t:b|1|2 t:a n:1|1',
  },
  {
    name: 'pass-through',
    program: PASSED,
    expected: 'caught conflict|hi|plain|forwarded conflict|out',
  },
  {
    name: 'sync-sort',
    program: SYNC,
    expected: '8|2|applied conflict|0 3|1 5|sorted conflict',
  },
  {
    name: 'closed-slot',
    program: CLOSED,
    expected: 'used failure|x|.',
  },
  {
    name: 'jobs',
    program: JOBS,
    expected:
      'ticked conflict|t|spawned conflict|s|gathered conflict|gh',
  },
  {
    name: 'closures',
    program: CLOSURES,
    expected: '2|sync conflict|c|async conflict|3|called conflict',
  },
  {
    name: 'map',
    program: MAP,
    expected: 'mapped conflict',
  },
]

// SLOT_DIR keeps the emitted programs where a reader can find them
const dir = process.env.SLOT_DIR ?? mkdtempSync(join(tmpdir(), 'term-slot-raise-native-'))
const only = process.env.SLOT_ONLY ?? ''
const caseOnly = process.env.SLOT_CASE ?? ''

for (const one of CASES.filter(c => !caseOnly || c.name === caseOnly)) {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({
      backend,
      program: one.program,
      resolve: env => projectResolver(process.cwd(), env),
      dir,
      name: `slot-${one.name}`,
    })

    if (ran.form === 'skipped') {
      console.log(`skip  ${one.name} ${backend}: ${ran.reason}`)
      continue
    }

    ok(
      `${one.name} ${backend}: prints what TypeScript prints`,
      ran.form === 'ran' && ran.output === one.expected,
      ran.form === 'ran'
        ? `got ${JSON.stringify(ran.output)}`
        : `${ran.stage}: ${ran.reason.slice(0, 900)}`,
    )
  }
}

// the infallible sort call stays the plain instance: no raising instance is written for a program with no raising call
if (!only || only === 'rust') {
  const plainSort = PLAIN_SORT
  const built = compile(
    { file: join(dir, 'plain-sort.tree'), text: plainSort },
    { resolve: projectResolver(process.cwd(), 'rust'), env: 'rust' } as never,
  )
  ok('plain sort compiles', built.ok)

  if (built.ok) {
    const rust = emitRust(built.program)
    ok('an infallible sort writes no raising instance', !rust.includes('_raising'))
    if (process.env.SLOT_PLAIN_OUT) {
      writeFileSync(process.env.SLOT_PLAIN_OUT, rust)
    }
  }
}

console.log(`\nslot-raise-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
