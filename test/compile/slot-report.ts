// A raise in a callback @term/site keeps for a host loop is reported, and the loop goes on (decision 096 rules 2 to 4 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0507). The library guards each call
// it makes through such a slot and hands the raise to `report-raise` (site code/report.tree), which writes
// `<place>: <form>: <note>` with `@term/base/log` `error`. The program, over the memory host: a key listener that
// raises and one that notes the key, an effect that raises on every run and one that notes the level, a cleanup that
// raises and one that notes, and a trait watcher that raises. Every noting callback must still run, the program must
// reach its end, and the log must carry one report line per raise. Then decision 100 (item 0518): the value slots
// answer empty after a raise and report it once at `<task>/<slot>`, a memo reads its fallback, and the node host answers
// a raising route 500 (TypeScript only, a served program).
//
// TypeScript and Kotlin run it. Rust and Swift do not yet take a raising task into a closed slot (Rust E0271, Swift a
// `try!` that ends the program at the slot): emitting a `halt exception` slot there is item term-self-host-001-0464
// (decision 086 rule 4), so those legs are named and skipped.
// Run: npx tsx test/compile/slot-report.ts   (REPORT_ONLY=kotlin for one backend)

import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer } from 'node:net'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'
import { buildOn } from './shared/run-on'
import type { Backend } from './shared/run-on'

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

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal
  find make-effect
  find on-cleanup
  find open-scope
  find close-scope
  find dispose-scope

load @term/site/code/dom/native/memory/dom
  find listen-key
  find fire-key

load @term/site/code/view/native/memory/device
  find watch-traits
  find change-trait

form tally
  mark shared
  link seen, like text

host heard
  make tally
    bind seen, text <>

task note
  take word, like text
  save heard/seen, text <{heard/seen}{word} >

task refuse-key
  take key, like text
  halt <no key {key}>

task note-key
  take key, like text
  call note
    text <key-{key}>

task refuse-trait
  take name, like text
  take value, like text
  halt <no trait {name}>

task refuse
  halt <no more>

task note-cleanup
  call note
    text <cleanup>

task run
  like text
  save first
    call listen-key
      read refuse-key
  save second
    call listen-key
      read note-key
  call fire-key
    text <a>
  save level
    call make-signal
      bind value, text <0>
  call make-effect
    task fails
      save now
        call read-signal
          bind self, read level
      call refuse
  call make-effect
    task follows
      save now
        call read-signal
          bind self, read level
      call note
        text <effect-{now}>
  call write-signal
    bind self, read level
    bind value, text <1>
  save scope, call open-scope
  call on-cleanup
    read refuse
  call on-cleanup
    read note-cleanup
  call close-scope
  call dispose-scope
    read scope
  save watching
    call watch-traits
      read refuse-trait
  call change-trait
    text <color-scheme>
    text <dark>
  call note
    text <end>
  send back, read heard/seen
`

const WANT = 'key-a effect-0 effect-1 cleanup end '

// each raise, once per run of its callback: the effect raises when it is made and again when the level moves
const REPORTS = [
  'listen-key: failure: no key a',
  'effect: failure: no more',
  'cleanup: failure: no more',
  'watch-traits: failure: no trait color-scheme',
]

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) =>
    base(
      importPath.replace(
        /native\/\{platform\}\/(dom|device|view)$/,
        'native/memory/$1',
      ),
      fromFile,
    )
}

const dir = mkdtempSync(join(tmpdir(), 'term-slot-report-'))
const only = process.env.REPORT_ONLY ?? ''
const RAN: Backend[] = ['typescript', 'kotlin']
const LATER: Backend[] = ['rust', 'swift']

for (const backend of LATER.filter(b => !only || b === only)) {
  console.log(
    `skip  ${backend}: a raising task into a closed slot is item term-self-host-001-0464`,
  )
}

for (const backend of RAN.filter(b => !only || b === only)) {
  const built = buildOn({
    backend,
    program: PROGRAM,
    resolve: pinned,
    dir,
    name: 'report',
  })

  if (built.form === 'skipped') {
    console.log(`skip  ${backend}: ${built.reason}`)
    continue
  }

  ok(
    `${backend}: a program whose kept callbacks raise compiles and builds`,
    built.form === 'built',
    built.form === 'failed' ? `${built.stage}: ${built.reason.slice(0, 600)}` : '',
  )

  if (built.form !== 'built') {
    continue
  }

  const run = spawnSync(built.command[0]!, built.command.slice(1), {
    encoding: 'utf8',
  })
  const output = String(run.stdout)
  const log = String(run.stderr)

  ok(
    `${backend}: the program runs to its end`,
    run.status === 0,
    `exit ${run.status}: ${log.slice(0, 600)}`,
  )
  ok(
    `${backend}: every callback after a raising one still ran`,
    output === WANT,
    `got ${JSON.stringify(output)}`,
  )

  for (const line of REPORTS) {
    ok(
      `${backend}: the log reports ${JSON.stringify(line)}`,
      log.includes(line),
      `log ${JSON.stringify(log.slice(0, 600))}`,
    )
  }

  const effects = log.split('effect: failure: no more').length - 1
  ok(
    `${backend}: the raising effect is reported on each of its two runs`,
    effects === 2,
    `${effects} reports`,
  )
}

// ---- decision 100: a value slot answers empty after a raise (item term-self-host-001-0518) ----
//
// Every render slot whose getter or build raises is drawn empty (the attribute and the text read `<>`, `show` an empty
// view, a list the other items, a gate its failed view), a memo reads its fallback, each raise is reported once at
// `<task>/<slot>` and never again by `run-effect` (no `effect:` line), the scope a raising build opened is closed and
// disposed (its cleanup runs, the owners stack ends empty), a raising `items` followed by a good one runs each old
// item's cleanup exactly once, and the next good run draws the right values again. One signal, `mode`, moves every
// getter from good to bad and back.

const VALUES = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal
  find make-memo
  find on-cleanup
  find owners

load @term/site/code/view/render
  find make-element
  find make-text
  find bind-attribute
  find make-dynamic-text
  find show
  find render-each
  find render-each-keyed
  find render-gate

load @term/site/code/dom/native/memory/dom
  find append
  find serialize

load @term/base/text
  find split

form tally
  mark shared
  link seen, like text

host heard
  make tally
    bind seen, text <>

host mode
  call make-signal
    bind value, text <good>

task note
  take word, like text
  save heard/seen, text <{heard/seen}{word} >

task is-bad
  like boolean
  send back
    call is-equal
      call read-signal
        bind self, read mode
      text <bad>

task refuse-when-bad
  take what, like text
  fork test
    hook test
      call is-bad
    hook hold
      halt <no {what}>

task attribute-source
  like text
  call refuse-when-bad
    text <attribute>
  send back, text <on>

task text-source
  like text
  call refuse-when-bad
    text <text>
  send back, text <hi>

task when-source
  like boolean
  call refuse-when-bad
    text <when>
  send back, true

task always
  like boolean
  send back, true

task build-yes
  like view
  send back
    call make-text
      text <yes>

task build-no
  like view
  send back
    call make-text
      text <no>

task build-refused
  like view
  call on-cleanup
    task drop-then
      call note
        text <show-then>
  fork test
    hook test
      call always
    hook hold
      halt <no then>
  send back
    call make-text
      text <never>

task items-source
  like list
    like text
  call refuse-when-bad
    text <items>
  send back
    call split
      text <a b c>
      text < >

task build-item
  take item, like text
  like view
  call on-cleanup
    task drop-item
      call note
        text <each-{item}>
  fork test
    hook test
      call is-equal
        read item
        text <b>
    hook hold
      halt <no build {item}>
  send back
    call make-text
      read item

task key-of
  take item, like text
  like text
  fork test
    hook test
      call is-equal
        read item
        text <c>
    hook hold
      halt <no key {item}>
  send back, read item

task build-keyed
  take item, like text
  like view
  call on-cleanup
    task drop-keyed
      call note
        text <keyed-{item}>
  fork test
    hook test
      call is-equal
        read item
        text <b>
    hook hold
      halt <no build {item}>
  send back
    call make-text
      read item

task status-source
  like text
  call refuse-when-bad
    text <status>
  send back, text <ready>

task build-pending
  like view
  send back
    call make-text
      text <pending>

task build-failed
  like view
  send back
    call make-text
      text <failed>

task build-ready
  like view
  send back
    call make-text
      text <ready>

task memo-source
  like text
  call refuse-when-bad
    text <memo>
  send back, text <fine>

task add-part
  take root, like view
  like view
  save part
    call make-element
      text <span>
  call append
    bind parent, read root
    bind child, read part
  send back, read part

task run
  like text
  save root
    call make-element
      text <main>
  save tagged
    call make-element
      text <div>
  call append
    bind parent, read root
    bind child, read tagged
  call bind-attribute
    bind node, read tagged
    bind name, text <data-x>
    bind source, read attribute-source
  save text-host
    call add-part
      read root
  call append
    bind parent, read text-host
    bind child
      call make-dynamic-text
        read text-source
  save show-host
    call add-part
      read root
  call show
    bind host, read show-host
    bind when, read when-source
    bind then, read build-yes
    bind other, read build-no
  save refused-host
    call add-part
      read root
  call show
    bind host, read refused-host
    bind when, read always
    bind then, read build-refused
    bind other, read build-no
  save each-host
    call add-part
      read root
  call render-each
    bind host, read each-host
    bind items, read items-source
    bind build, read build-item
  save keyed-host
    call add-part
      read root
  call render-each-keyed
    bind host, read keyed-host
    bind items, read items-source
    bind key, read key-of
    bind build, read build-keyed
  save gate-host
    call add-part
      read root
  call render-gate
    bind host, read gate-host
    bind status, read status-source
    bind pending, read build-pending
    bind failed, read build-failed
    bind ready, read build-ready
  save memo
    call make-memo
      bind compute, read memo-source
      bind fallback, text <unknown>
  save one
    call serialize
      read root
  save one-memo
    call read-signal
      bind self, read memo
  call write-signal
    bind self, read mode
    bind value, text <bad>
  save late
    call make-memo
      bind compute, read memo-source
      bind fallback, text <late>
  save two
    call serialize
      read root
  save two-memo
    call read-signal
      bind self, read memo
  save two-late
    call read-signal
      bind self, read late
  call write-signal
    bind self, read mode
    bind value, text <good>
  save three
    call serialize
      read root
  save three-memo
    call read-signal
      bind self, read memo
  save three-late
    call read-signal
      bind self, read late
  save depth, read owners/length
  send back, text <{one} {one-memo}|{two} {two-memo} {two-late}|{three} {three-memo} {three-late}|{heard/seen}|owners {depth}>
`

const GOOD =
  '<main><div data-x="on"></div><span>hi</span><span>yes</span><span></span><span>ac</span><span>a</span><span>ready</span></main>'
const BAD =
  '<main><div data-x=""></div><span></span><span></span><span></span><span></span><span></span><span>failed</span></main>'
const VALUES_WANT = [
  `${GOOD} fine`,
  `${BAD} unknown late`,
  `${GOOD} fine fine`,
  'show-then each-b keyed-b each-a each-c keyed-a each-b keyed-b ',
  'owners 0',
].join('|')

// each raise, by its place, and how many times the program raises there
const VALUE_REPORTS: [string, number][] = [
  ['bind-attribute/source: failure: no attribute', 1],
  ['make-dynamic-text/source: failure: no text', 1],
  ['show/when: failure: no when', 1],
  ['build-owned/build: failure: no then', 1],
  ['render-each/build: failure: no build b', 2],
  ['render-each/items: failure: no items', 1],
  ['render-each-keyed/items: failure: no items', 1],
  ['render-each-keyed/key: failure: no key c', 2],
  ['render-each-keyed/build: failure: no build b', 2],
  ['render-gate/status: failure: no status', 1],
  // the memo's own raise on the bad run, and the late memo's first call and its effect's first run
  ['make-memo/compute: failure: no memo', 3],
]

const count = (text: string, line: string): number =>
  text.split(line).length - 1

for (const backend of RAN.filter(b => !only || b === only)) {
  const built = buildOn({
    backend,
    program: VALUES,
    resolve: pinned,
    dir,
    name: 'values',
  })

  if (built.form === 'skipped') {
    console.log(`skip  ${backend}: ${built.reason}`)
    continue
  }

  ok(
    `${backend}: a program whose value slots raise compiles and builds`,
    built.form === 'built',
    built.form === 'failed' ? `${built.stage}: ${built.reason.slice(0, 600)}` : '',
  )

  if (built.form !== 'built') {
    continue
  }

  const run = spawnSync(built.command[0]!, built.command.slice(1), {
    encoding: 'utf8',
  })
  const output = String(run.stdout)
  const log = String(run.stderr)

  ok(
    `${backend}: the value program runs to its end`,
    run.status === 0,
    `exit ${run.status}: ${log.slice(0, 600)}`,
  )
  ok(
    `${backend}: each slot draws empty after a raise, the rest draws, and the next good run draws again`,
    output.trim() === VALUES_WANT,
    `got ${JSON.stringify(output)}\nwant ${JSON.stringify(VALUES_WANT)}`,
  )

  for (const [line, times] of VALUE_REPORTS) {
    const seen = count(log, line)
    ok(
      `${backend}: ${JSON.stringify(line)} is reported ${times} time(s)`,
      seen === times,
      `${seen} reports in ${JSON.stringify(log.slice(0, 900))}`,
    )
  }

  ok(
    `${backend}: no value slot's raise reaches run-effect's guard`,
    count(log, 'effect: failure') === 0,
    JSON.stringify(log.slice(0, 900)),
  )
}

// ---- decision 100 rule 7: the node host answers a raising route 500, reported once at `route` ----
//
// The program serves a route that raises on /broken through the node host. The request handler's guard answers it with
// `answer-failure`, so /broken answers 500 `internal error` with one `route:` line in the log, and / still answers 200.
// Built under the package's own tmp/, so the node transport's hono resolves from the emitted module.

const freePort = await new Promise<number>(settle => {
  const probe = createServer()
  probe.listen(0, '127.0.0.1', () => {
    const port = (probe.address() as AddressInfo).port
    probe.close(() => settle(port))
  })
})

const ROUTED = `load @term/site/code/view/native/{platform}/host
  find host

load @term/site/code/dom/dom
  find view

load @term/site/code/http/http
  find request
  find response

load @term/base/maybe
  find maybe

task broken-route
  take host, like view
  take request, like request
  like maybe, like response
  fork test
    hook test
      call is-equal
        read request/path
        text </broken>
    hook hold
      halt <no page>
  send back, make none

task run
  call host
    read broken-route
    code ${freePort}
`

if (!only || only === 'typescript') {
  mkdirSync(join(process.cwd(), 'tmp'), { recursive: true })
  const routeDir = mkdtempSync(join(process.cwd(), 'tmp', 'slot-report-route-'))
  const built = buildOn({
    backend: 'typescript',
    program: ROUTED,
    resolve: env => projectResolver(process.cwd(), env),
    dir: routeDir,
    name: 'routed',
  })

  ok(
    'node: a host serving a raising route compiles',
    built.form === 'built',
    built.form === 'failed' ? `${built.stage}: ${built.reason.slice(0, 600)}` : '',
  )

  if (built.form === 'built') {
    const server = spawn(built.command[0]!, built.command.slice(1), {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let log = ''
    server.stderr.on('data', chunk => {
      log += String(chunk)
    })
    const ask = async (path: string): Promise<string> => {
      for (let tries = 0; tries < 100; tries++) {
        try {
          const answer = await fetch(`http://127.0.0.1:${freePort}${path}`)

          return `${answer.status} ${await answer.text()}`
        } catch {
          await new Promise(settle => setTimeout(settle, 100))
        }
      }

      return 'no answer'
    }
    const broken = await ask('/broken')
    const home = await ask('/')
    await new Promise(settle => setTimeout(settle, 200))
    server.kill()
    ok('node: a raising route answers 500', broken === '500 internal error', broken)
    ok('node: a route that draws still answers 200', home.startsWith('200 '), home.slice(0, 200))
    ok(
      'node: the raise is reported once, at route',
      count(log, 'route: failure: no page') === 1,
      JSON.stringify(log.slice(0, 900)),
    )
  }

  rmSync(routeDir, { recursive: true, force: true })
}

rmSync(dir, { recursive: true, force: true })
console.log(`\nslot-report: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
