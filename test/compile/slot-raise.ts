// A task-typed slot raises what it declares, a callback the task only calls passes its raises through, and a job
// raises where its maker waits it (decisions 086, 089 and 092 of note/project/term/self-host/change/
// 001-finish-self-host, item term-self-host-001-0463). Before them, check/effects.tree `raise-sets-of` dropped every
// call through a parameter, so the cask's `hand(dispatch)` shape (tmp/self-host/cm-0012) built on every backend with
// `hand`'s raise set empty, and Rust failed E0271 on the cast.
//
// Held here. 089: the cm-0012 shape builds, and the call of `hand` raises what `dispatch` raises; a parameter the task
// keeps (saved into a record) is closed, and a raising task put there is refused as `raise-escapes-slot` naming the
// keeping line; `halt kink` on a kept slot is `slot-kink-kept`; forwarding passes through; a guard inside the task
// subtracts; a bodyless task is closed unless it says `halt kink`. 086: a closed slot, a closure, a local, a record
// field and a returned task are each checked. 092: a value-position tick's raise is charged at the wait (a guard around
// the tick subtracts nothing, one around the wait does), a handle of a raising job given back is `handle-escapes`, a
// statement tick charges no task, and `map-concurrent` raises its worker's form, statically and when run.
// Run: npx tsx test/compile/slot-raise.ts (from deck/term/deck/term)

import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  existsSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { compile } from '@term/make/code/compile/compile'
import { siblingResolver, stdlibResolver } from '@term/make/code/resolve'
import {
  nativePrelude,
  withNativeEnv,
} from '@term/make/code/compile/native'
import type { Resolver } from '@term/make/code/compile/load'
import { projectLeanOf } from '@term/call/code/role-of'
import { diagnosticNames } from '@term/make/code/parser/diagnostic'

// A NAMED SKIP until the checks are in the compiler (item 0463's line-lock window lands them)
if (
  !(diagnosticNames() as string[]).includes('handle-escapes') &&
  process.env.SLOT_RAISE_FAIL_FIRST !== '1'
) {
  console.log(
    'skip  slot-raise: decisions 086, 089 and 092 are not in the compiler (term-self-host-001-0463)',
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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')

const LEAN = { leanOf: () => true, library: true, roll: true }

type Result = ReturnType<typeof compile>

const messages = (result: Result): string =>
  (result.diagnostics ?? [])
    .filter(d => d.severity !== 'warning')
    .map(d => `${d.name}: ${d.message}`)
    .join(' | ')

const named = (result: Result, name: string): string[] =>
  (result.diagnostics ?? []).filter(d => d.name === name).map(d => d.message)

// the exceptions the roll says a task raises
const halts = (result: Result, name: string): string[] => {
  const entry = (result.roll?.task ?? []).find(e => e.name === name)

  return ((entry?.halt as string[] | undefined) ?? []).slice().sort()
}

const build = (file: string, text: string): Result =>
  compile({ file, text }, LEAN)

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

const hand = (halts: string): string => `task hand
  mark async
  take handler
    like task
      wait true
      take message, like text
      like text${halts}
  like text
  back handler(<hello>)
`

const run = (value: string, callee = 'hand'): string => `task run
  mark async
  like text
  back ${callee}(${value})
`

// ---- 089: a callback the task only calls passes its raises through ----

// 1. the cm-0012 shape: it builds, and the call raises what the argument raises
const passed = build('passed.tree', `${TASKS}\n${hand('')}\n${run('dispatch')}`)
ok('the cm-0012 shape builds: hand only calls its handler', passed.ok, messages(passed))
ok(
  "and hand's call raises the argument's set: run raises failure",
  halts(passed, 'run').includes('failure'),
  JSON.stringify(halts(passed, 'run')),
)
ok(
  'and hand itself raises nothing of its own',
  !halts(passed, 'hand').includes('failure'),
  JSON.stringify(halts(passed, 'hand')),
)
const passedEcho = build('passed-echo.tree', `${TASKS}\n${hand('')}\n${run('echo')}`)
ok(
  'an infallible argument passes nothing through',
  passedEcho.ok && !halts(passedEcho, 'run').includes('failure'),
  messages(passedEcho) + JSON.stringify(halts(passedEcho, 'run')),
)

// 2. a parameter the task keeps is closed, and the refusal names the keeping line
const KEEPER = (halt: string): string => `form holder
  link handler
    like task
      wait true
      take message, like text
      like text

task keep
  take handler
    like task
      wait true
      take message, like text
      like text${halt}
  like holder
  back make(holder, bind(handler, handler))
`
const kept = build(
  'kept.tree',
  `${TASKS}\n${KEEPER('')}\ntask run\n  like holder\n  back keep(dispatch)\n`,
)
const keptSaid = named(kept, 'raise-escapes-slot')
ok(
  'a raising task into a parameter the task keeps is refused',
  !kept.ok && keptSaid.length === 1,
  kept.ok ? 'compiled' : messages(kept),
)
ok(
  'and the refusal names the line that keeps it',
  keptSaid.length === 1 &&
    keptSaid[0]!.includes('"handler" of "keep"') &&
    keptSaid[0]!.includes('kept by line'),
  keptSaid.join(' | '),
)

// 3. `halt kink` on that kept slot
const kinked = build(
  'kinked.tree',
  `${TASKS}\n${KEEPER('\n      halt kink')}\ntask run\n  like holder\n  back keep(echo)\n`,
)
ok(
  'halt kink on a slot the body keeps is slot-kink-kept',
  !kinked.ok && named(kinked, 'slot-kink-kept').length === 1,
  kinked.ok ? 'compiled' : messages(kinked),
)
const both = build(
  'both.tree',
  `${TASKS}\n${hand('\n      halt kink\n      halt failure')}\n${run('echo')}`,
)
ok(
  'halt kink beside a halt form on one slot is refused',
  !both.ok && named(both, 'slot-kink-kept').length === 1,
  both.ok ? 'compiled' : messages(both),
)

// 4. forwarding: a parameter handed to a pass-through parameter passes through too
const forwarded = build(
  'forwarded.tree',
  `${TASKS}\n${hand('')}
task outer
  mark async
  take given
    like task
      wait true
      take message, like text
      like text
  like text
  back hand(given)

${run('dispatch', 'outer')}`,
)
ok('forwarding builds', forwarded.ok, messages(forwarded))
ok(
  'and outer(dispatch) raises failure',
  halts(forwarded, 'run').includes('failure'),
  JSON.stringify(halts(forwarded, 'run')),
)

// 5. a guard inside the task subtracts the argument's raise
const guarded = build(
  'guarded.tree',
  `${TASKS}
task hand
  mark async
  take handler
    like task
      wait true
      take message, like text
      like text
  like text
  fork
    mark unsafe
    back handler(<hello>)
  halt take
    take problem
    back <caught>

${run('dispatch')}`,
)
ok('a guard around the call inside the task builds', guarded.ok, messages(guarded))
ok(
  'and the task raises nothing from it',
  !halts(guarded, 'run').includes('failure'),
  JSON.stringify(halts(guarded, 'run')),
)

// 6. a task written in a backend's own folder (`native/<env>/`) is never inferred: closed, unless it says `halt kink`.
// A signature with no body at all cannot be called in one program (nothing defines it), so the platform task stands
// for both
const platform = (halt: string): string =>
  `${TASKS}\n${hand(halt)}\n${run('dispatch')}`
const closedDecl = build('/probe/native/node/closed-decl.tree', platform(''))
ok(
  'a raising task into a platform task with no halt kink is refused',
  !closedDecl.ok && named(closedDecl, 'raise-escapes-slot').length === 1,
  closedDecl.ok ? 'compiled' : messages(closedDecl),
)
const kinkDecl = build('/probe/native/node/kink-decl.tree', platform('\n      halt kink'))
ok('with halt kink it builds', kinkDecl.ok, messages(kinkDecl))
ok(
  'and passes through',
  halts(kinkDecl, 'run').includes('failure'),
  JSON.stringify(halts(kinkDecl, 'run')),
)

// ---- 086: closed places ----

// 7. a slot with halt lines: the set is declared
const open = build(
  'open.tree',
  `${TASKS}\n${hand('\n      halt failure')}\n${run('dispatch')}`,
)
ok('a declared slot builds', open.ok, messages(open))
ok(
  "and the slot's set is hand's",
  halts(open, 'hand').includes('failure'),
  JSON.stringify(halts(open, 'hand')),
)

// 8. a closure into a kept slot, a local holding a raising task into one
const closure = build(
  'closure.tree',
  `${TASKS}\n${KEEPER('')}
task run
  like holder
  save made
    keep
      task
        mark async
        take message, like text
        like text
        halt <boom>
  back made
`,
)
ok(
  'a raising closure into a kept slot is refused',
  !closure.ok && named(closure, 'raise-escapes-slot').length === 1,
  closure.ok ? 'compiled' : messages(closure),
)
const local = build(
  'local.tree',
  `${TASKS}\n${KEEPER('')}
task run
  like holder
  save chosen, dispatch
  back keep(chosen)
`,
)
ok(
  'a local holding a raising task, into a kept slot, is refused',
  !local.ok && named(local, 'raise-escapes-slot').some(m => m.includes('"chosen"')),
  local.ok ? 'compiled' : messages(local),
)

// 9. a record field typed as a task, and a call through it
const FIELD = (halt: string): string => `${TASKS}
form holder
  link handler
    like task
      wait true
      take message, like text
      like text${halt}

task make-holder
  like holder
  back make(holder, bind(handler, dispatch))

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
    named(fieldClosed, 'raise-escapes-slot').some(m =>
      m.includes('"handler" of "holder"'),
    ),
  fieldClosed.ok ? 'compiled' : messages(fieldClosed),
)
const fieldOpen = build('field-open.tree', FIELD('\n      halt failure'))
ok('with halt failure on the field it builds', fieldOpen.ok, messages(fieldOpen))
ok(
  "a call through the field raises the field's set",
  halts(fieldOpen, 'use').includes('failure'),
  JSON.stringify(halts(fieldOpen, 'use')),
)

// 10. a task typed as giving back a task
const returned = build(
  'returned.tree',
  `${TASKS}
task pick
  like task
    wait true
    take message, like text
    like text
  back dispatch
`,
)
ok(
  'a raising task given back where the result is a closed task type is refused',
  !returned.ok && named(returned, 'raise-escapes-slot').length === 1,
  returned.ok ? 'compiled' : messages(returned),
)

// ---- 092: a job raises where its maker waits it ----

const stdlib = stdlibResolver()!
const sibling = siblingResolver()!
const both2: Resolver = (path, from, how) =>
  stdlib(path, from, how) ?? sibling(path, from, how)
const resolve = withNativeEnv('node', both2)
const testLean = projectLeanOf(join(TERM, 'deck/test'))
const leanOf = (file: string): boolean =>
  file === 'main.tree' || testLean(file)

const project = (text: string): Result =>
  compile({ file: 'main.tree', text }, { resolve, leanOf, roll: true } as never)

const JOBS = `load @term/base/task
  find handle
  find spawn
  find gather

load @term/base/exception
  find conflict

task fetch
  mark async
  take x, like text
  like text
  fork test, is-equal(x, <>)
    hold
      halt conflict
        bind thing, x
  back x

task fine
  mark async
  take x, like text
  like text
  back x
`

const jobs = project(`${JOBS}
task at-wait
  mark async
  like text
  save work, tick fetch(<a>)
  back work/wait()

task guard-tick
  mark async
  like text
  host lanes, make list
  fork
    mark unsafe
    lanes/push(tick fetch(<a>))
  halt take
    take problem
    save skip, 0
  save first, lanes/0
  back first/wait()

task guard-wait
  mark async
  like text
  save work, tick fetch(<a>)
  fork
    mark unsafe
    back work/wait()
  halt take
    take problem
    back <caught>

task statement-tick
  mark async
  like void
  tick fetch(<a>)

task gathered
  mark async
  like list, like text
  save works, make list
  save one
    task
      mark async
      like text
      back fetch(<a>)
  works/push(one)
  back gather(works)

task fine-handle
  like handle text
  save work, tick fine(<a>)
  back work
`)
ok('the job cases build', jobs.ok, messages(jobs))
ok(
  'a value-position tick is charged at the wait',
  halts(jobs, 'at-wait').includes('conflict'),
  JSON.stringify(halts(jobs, 'at-wait')),
)
ok(
  'a guard around the tick subtracts nothing of the job',
  halts(jobs, 'guard-tick').includes('conflict'),
  JSON.stringify(halts(jobs, 'guard-tick')),
)
ok(
  'a guard around the wait subtracts the job',
  !halts(jobs, 'guard-wait').includes('conflict'),
  JSON.stringify(halts(jobs, 'guard-wait')),
)
ok(
  'a statement tick adds nothing to the ticker',
  !halts(jobs, 'statement-tick').includes('conflict'),
  JSON.stringify(halts(jobs, 'statement-tick')),
)
ok(
  "a gather raises its tasks' set",
  halts(jobs, 'gathered').includes('conflict'),
  JSON.stringify(halts(jobs, 'gathered')),
)
ok('the handle of an infallible job may be given back', jobs.ok)

const escaping = project(`${JOBS}
task give-back
  like handle text
  save work, tick fetch(<a>)
  back work
`)
ok(
  'the handle of a raising job given back is handle-escapes',
  !escaping.ok && named(escaping, 'handle-escapes').length === 1,
  escaping.ok ? 'compiled' : messages(escaping),
)

// map-concurrent: its worker passes through the lane job, statically and when run on TypeScript
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

task safe
  mark async
  take item, like unknown
  take index, like number
  like unknown
  fork
    mark unsafe
    back risky(item, index)
  halt take
    take problem
    back <kept>

task items-of
  like list, like unknown
  save items, make list
  items/push(<a>)
  items/push(<b>)
  items/push(<c>)
  back items

task run
  mark async
  like text
  save answers, map-concurrent(items-of(), risky, 2)
  back <done>

task run-safe
  mark async
  like text
  save answers, map-concurrent(items-of(), safe, 2)
  back <done>
`
const mapped = project(MAP)
ok('map-concurrent over a raising worker builds', mapped.ok, messages(mapped))
ok(
  "and raises the worker's form statically",
  halts(mapped, 'run').includes('conflict'),
  JSON.stringify(halts(mapped, 'run')),
)
ok(
  'and a guarded worker raises nothing of it',
  !halts(mapped, 'run-safe').includes('conflict'),
  JSON.stringify(halts(mapped, 'run-safe')),
)

const baseTree = join(TERM, 'deck', 'base')
const readRuntime = (path: string): string | undefined => {
  if (existsSync(path)) {
    return readFileSync(path, 'utf8')
  }

  if (!/^@term\/base\//.test(path)) {
    return undefined
  }

  const file = join(baseTree, path.replace(/^@term\/base\//, ''))

  return existsSync(file) ? readFileSync(file, 'utf8') : undefined
}

if (mapped.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-slot-raise-'))
  const file = join(dir, 'map.ts')
  writeFileSync(
    file,
    nativePrelude(mapped.program, 'node', readRuntime) + '\n' + mapped.typescript,
  )
  const mod = (await import(pathToFileURL(file).href)) as {
    run: () => Promise<string>
  }
  let form: string | undefined

  try {
    await mod.run()
  } catch (error) {
    form = (error as { form?: string }).form
  }

  ok("and when run on TypeScript it raises the worker's own form", form === 'conflict', String(form))
}

console.log(`\nslot-raise: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
