// A task-typed slot raises only what it declares, and a raising task put in a closed slot is refused (decision 086 of
// note/project/term/self-host/change/001-finish-self-host, rules 1 to 3, item term-self-host-001-0463). Before it,
// check/effects.tree `raise-sets-of` dropped every call through a parameter, so the cask's `hand(dispatch)` shape
// (tmp/self-host/cm-0012) built on every backend with `hand`'s raise set empty, and Rust failed E0271 on the cast.
// Held here: a raising task passed by name into a slot with no `halt` line is refused as `raise-escapes-slot` naming
// the task, the exception and the slot; with `halt failure` on the slot it builds and the caller's raise set holds
// `failure`; an infallible task builds in either; a closure, a local saved from a task, a record field and a returned
// task are each checked the same; and the cm-0012 repro itself (its own two files, @term/base's json) is refused.
// Run: npx tsx test/compile/slot-raise.ts (from deck/term/deck/term)

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { diagnosticNames } from '@term/make/code/parser/diagnostic'

// A NAMED SKIP until the check is in the compiler: item 0463's census found 73 sites the check refuses, stdlib
// higher-order tasks among them (sort, mount, find-one, supervise, map-concurrent, fuzz, on-message), so the window
// was taken back and the question escalated (term-self-host-001-0463's log entry). The suite runs itself once
// `raise-escapes-slot` is a diagnostic the compiler has
if (!(diagnosticNames() as string[]).includes('raise-escapes-slot')) {
  console.log(
    'skip  slot-raise: decision 086 rule 3 is not in the compiler (escalated by term-self-host-001-0463)',
  )
  process.exit(0)
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

const LEAN = { leanOf: () => true, library: true, roll: true }

const TASKS = `task dispatch
  mark async
  take message, like text
  like text
  fork test, is-equal(message, <>)
    hold
      halt <empty message>
  back message

task echo
  mark async
  take message, like text
  like text
  back message
`

const slot = (halts: string): string => `task hand
  mark async
  take handler
    like task
      wait true
      take message, like text
      like text${halts}
  like text
  back handler(<hello>)
`

const CLOSED = slot('')
const OPEN = slot('\n      halt failure')

const run = (value: string): string => `task run
  mark async
  like text
  back hand(${value})
`

const program = (hand: string, value: string): string =>
  `${TASKS}\n${hand}\n${run(value)}`

type Result = ReturnType<typeof compile>

const messages = (result: Result): string =>
  (result.diagnostics ?? [])
    .filter(d => d.severity !== 'warning')
    .map(d => `${d.name}: ${d.message}`)
    .join(' | ')

const escapes = (result: Result): string[] =>
  (result.diagnostics ?? [])
    .filter(d => d.name === 'raise-escapes-slot')
    .map(d => d.message)

// the exceptions the roll says a task raises
const halts = (result: Result, name: string): string[] => {
  const entry = (result.roll?.task ?? []).find(e => e.name === name)

  return ((entry?.halt as string[] | undefined) ?? []).slice().sort()
}

const build = (file: string, text: string): Result =>
  compile({ file, text }, LEAN)

// 1. the cm-0012 shape: a raising task into a slot with no `halt` line
const closedRaising = build('closed-raising.tree', program(CLOSED, 'dispatch'))
const said = escapes(closedRaising)
ok(
  'a raising task passed into a slot with no halt line is refused',
  !closedRaising.ok && said.length === 1,
  closedRaising.ok ? 'compiled' : messages(closedRaising),
)
ok(
  'the refusal names the task, the exception and the slot',
  said.length === 1 &&
    said[0]!.includes('"dispatch"') &&
    said[0]!.includes('failure') &&
    said[0]!.includes('"handler" of "hand"'),
  said.join(' | '),
)

// 2. the slot declares it
const openRaising = build('open-raising.tree', program(OPEN, 'dispatch'))
ok(
  'with halt failure on the slot it builds',
  openRaising.ok,
  messages(openRaising),
)
ok(
  "and the slot's set is the caller's: hand raises failure",
  halts(openRaising, 'hand').includes('failure'),
  JSON.stringify(halts(openRaising, 'hand')),
)
ok(
  'and so does what calls hand',
  halts(openRaising, 'run').includes('failure'),
  JSON.stringify(halts(openRaising, 'run')),
)

// 3. an infallible task fits either slot
const closedEcho = build('closed-echo.tree', program(CLOSED, 'echo'))
ok('an infallible task into a closed slot builds', closedEcho.ok, messages(closedEcho))
ok(
  'and a closed slot raises nothing',
  halts(closedEcho, 'hand').length === 0,
  JSON.stringify(halts(closedEcho, 'hand')),
)
const openEcho = build('open-echo.tree', program(OPEN, 'echo'))
ok('an infallible task into an open slot builds', openEcho.ok, messages(openEcho))

// 4. a closure written at the call
const CLOSURE = `${TASKS}
${CLOSED}
task run
  mark async
  like text
  save reply
    call hand
      task
        mark async
        take message, like text
        like text
        halt <boom>
  back reply
`
const closure = build('closure.tree', CLOSURE)
ok(
  'a raising closure into a closed slot is refused',
  !closure.ok && escapes(closure).length === 1,
  closure.ok ? 'compiled' : messages(closure),
)

// 5. a local saved from a task by name
const LOCAL = `${TASKS}
${CLOSED}
task run
  mark async
  like text
  save chosen, dispatch
  back hand(chosen)
`
const local = build('local.tree', LOCAL)
ok(
  'a local holding a raising task, into a closed slot, is refused',
  !local.ok && escapes(local).some(m => m.includes('"chosen"')),
  local.ok ? 'compiled' : messages(local),
)

// 6. a record field typed as a task, and a call through it
const FIELD = (halt: string): string => `${TASKS}
form holder
  link handler
    like task
      wait true
      take message, like text
      like text${halt}

task build
  like holder
  back
    make holder
      bind handler, dispatch

task use
  mark async
  take given, like holder
  like text
  back given/handler(<hello>)
`
const fieldClosed = build('field-closed.tree', FIELD(''))
ok(
  'a raising task bound to a closed field is refused',
  !fieldClosed.ok &&
    escapes(fieldClosed).some(m => m.includes('"handler" of "holder"')),
  fieldClosed.ok ? 'compiled' : messages(fieldClosed),
)
const fieldOpen = build(
  'field-open.tree',
  FIELD('\n      halt failure'),
)
ok('with halt failure on the field it builds', fieldOpen.ok, messages(fieldOpen))
ok(
  "a call through the field raises the field's set",
  halts(fieldOpen, 'use').includes('failure'),
  JSON.stringify(halts(fieldOpen, 'use')),
)

// 7. a task typed as giving back a task
const RETURNED = `${TASKS}
task pick
  like task
    wait true
    take message, like text
    like text
  back dispatch
`
const returned = build('returned.tree', RETURNED)
ok(
  'a raising task given back where the result is a closed task type is refused',
  !returned.ok && escapes(returned).length === 1,
  returned.ok ? 'compiled' : messages(returned),
)

// 8. the cm-0012 repro as written: its own two files, @term/base's json stringify (a native raises failure)
const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'term-slot-raise-')))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
writeFileSync(join(root, 'deck.tree'), 'deck @probe/slot-raise\n  code <0.0.0>\n')
const REPRO = join(TERM, 'tmp/self-host/0463/cm-0012')
const main = readFileSync(join(REPRO, 'main.tree'), 'utf8')
writeFileSync(join(root, 'code/main.tree'), main)
writeFileSync(
  join(root, 'code/dispatch.tree'),
  readFileSync(join(REPRO, 'dispatch.tree'), 'utf8'),
)
const repro = compile(
  { file: join(root, 'code/main.tree'), text: main },
  { resolve: projectResolver(root, 'node'), env: 'node' },
)
ok(
  'the cm-0012 repro is refused as raise-escapes-slot',
  !repro.ok &&
    escapes(repro).some(
      m =>
        m.includes('"dispatch"') &&
        m.includes('failure') &&
        m.includes('"handler" of "hand"'),
    ),
  repro.ok ? 'compiled' : messages(repro),
)

console.log(`\nslot-raise: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
