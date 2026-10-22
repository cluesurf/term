// `mark sole` and `mark hide` ENFORCED (term/affine-kinds-0008, 0009, term-affine-kinds-0001; decision
// note/project/term/affine-kinds/decision/001-many-by-default-sole-and-hide-declared-per-form.md).
//
// Each case is compiled for every backend env (node, rust, swift, kotlin): the gates run in the shared front end after
// the checker, so a refusal is the same diagnostic on all four before any backend emits. The passing cases are then
// built and RUN on each backend whose toolchain is installed, the output compared.
//
//   sole-reused     a double use, a use after a move into a call, a use inside a walk of a name bound outside it
//   (passes)        a fork that hands the permit on once per arm: the max over arms, not the sum
//   sole-captured   a closure naming a sole value from outside it
//   sole-generic    a sole type as a list element
//   sole-unearned   a form holding a sole field without `mark sole` (and through another form); with it, it builds
//   hidden-make     `make permit` from another file, a case of a hidden form, a bodyless task answering one
//   (passes)        the declaring file makes it, another file reads its fields, a file under the package's test/ makes it
//
// Run: sh tmp/run-term-ts.sh test/check/sole-hide.ts   (SOLE_ONLY=typescript|rust|swift|kotlin runs one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { compile } from '@term/make/code/compile/compile'
import type { Resolver, Source } from '@term/make/code/compile/load'
import { BACKENDS, runOn } from '../compile/shared/run-on'
import type { Backend } from '../compile/shared/run-on'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const ENV: Record<Backend, string> = { typescript: 'node', rust: 'rust', swift: 'swift', kotlin: 'kotlin' }
const only = process.env.SOLE_ONLY ?? ''
const backends = BACKENDS.filter(b => !only || b === only)

// `@app/<path>` is `/pkg/code/<path>.tree`, so `/pkg/test/` holds the package's tests; anything else is the stdlib
function build(files: Record<string, string>, main: string, env: string, file = '/pkg/code/main.tree') {
  const stdlib = projectResolver(process.cwd(), env as never)
  const resolve: Resolver = (path, from, how) =>
    files[path] !== undefined
      ? ({ file: `/pkg/code/${path.slice('@app/'.length)}.tree`, text: files[path]! } as Source)
      : stdlib(path, from, how)

  return compile({ file, text: main }, { resolve, env })
}

type Built = ReturnType<typeof build>

const said = (result: Built): string =>
  result.ok ? 'it built' : result.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | ')

// refused on every backend with `code`, and the message holds each of `holds`
function refusedEverywhere(name: string, code: string, files: Record<string, string>, main: string, holds: string[] = [], file?: string): void {
  for (const backend of backends) {
    const result = build(files, main, ENV[backend], file)
    const hit = result.ok ? undefined : result.diagnostics.find(d => d.name === code)
    ok(
      `${backend}: ${name} is refused as ${code}`,
      hit !== undefined && holds.every(text => hit.message.includes(text)),
      hit ? hit.message : said(result),
    )
  }
}

function buildsEverywhere(name: string, files: Record<string, string>, main: string, file?: string): void {
  for (const backend of backends) {
    const result = build(files, main, ENV[backend], file)
    ok(`${backend}: ${name} builds`, result.ok, said(result))
  }
}

// ---- sole ----

const PERMIT = `form permit
  mark sole
  link note, like text

task grant
  take note, like text
  like permit
  send back
    make permit
      bind note, read note

task spend
  take permit, like permit
  like text
  send back, read permit/note
`

const twice = `${PERMIT}
task run
  like text
  save p, grant(<n1>)
  save a, spend(p)
  send back, spend(p)
`
refusedEverywhere('a permit spent twice', 'sole-reused', {}, twice, ['"p"', 'handed on at line'])

const afterMove = `${PERMIT}
task keep
  take permit, like permit
  like permit
  send back, read permit

task run
  like text
  save p, grant(<n1>)
  save q, keep(p)
  send back, read p/note
`
// reading a plain field consumes nothing, but a value handed on is gone: a read after the move is refused
refusedEverywhere('a use after a move into a call', 'sole-reused', {}, afterMove, ['"p"', 'read here after it was handed on'])

const readsThenMoves = `${PERMIT}
task run
  like text
  save p, grant(<n1>)
  save a, read p/note
  save b, read p/note
  send back, spend(p)
`
buildsEverywhere('two plain field reads, then one move', {}, readsThenMoves)

// a method called on a sole value hands it on, as an argument does (term-affine-kinds-0003, gap 170)
const STAMPED = `form permit
  mark sole
  link note, like text
  task stamp
    take self
    like text
    send back, read self/note

task grant
  take note, like text
  like permit
  send back
    make permit
      bind note, read note

task spend
  take permit, like permit
  like text
  send back, read permit/note
`
const methodThenSpend = `${STAMPED}
task run
  like text
  save p, grant(<n1>)
  save a, call p/stamp
  send back, spend(p)
`
refusedEverywhere('a permit stamped by a method, then spent', 'sole-reused', {}, methodThenSpend, ['"p"', 'handed on at line'])

const methodOnce = `${STAMPED}
task run
  like text
  save p, grant(<n1>)
  save a, read p/note
  send back, call p/stamp
`
buildsEverywhere('a field read, then one method call', {}, methodOnce)

// a match whose arm takes the subject's fields hands the subject on to it
const TICKET = `form ticket
  mark sole
  case open
    link note, like text
  case shut

task issue
  take note, like text
  like ticket
  send back
    make open
      bind note, read note

task spend-ticket
  take t, like ticket
  like text
  send back, <spent>
`
const matchThenSpend = `${TICKET}
task run
  like text
  save t, issue(<n1>)
  save seen, <none>
  sift t
    case open
      link note
      save seen, read note
    case shut
      save seen, <shut>
  send back, spend-ticket(t)
`
refusedEverywhere('a ticket matched into its fields, then spent', 'sole-reused', {}, matchThenSpend, ['"t"', 'handed on at line'])

const matchBindsNothing = `${TICKET}
task run
  like text
  save t, issue(<n1>)
  save seen, <none>
  sift t
    case open
      save seen, <open>
    case shut
      save seen, <shut>
  send back, spend-ticket(t)
`
buildsEverywhere('a match that takes no field, then one spend', {}, matchBindsNothing)

const moveThenMove = `${PERMIT}
task keep
  take permit, like permit
  like permit
  send back, read permit

task run
  like text
  save p, grant(<n1>)
  save q, keep(p)
  save r, p
  send back, spend(r)
`
refusedEverywhere('a save of a permit already moved into a call', 'sole-reused', {}, moveThenMove, ['"p"'])

const looped = `${PERMIT}
task run
  take notes, like list, like text
  like text
  save p, grant(<n1>)
  save last, <none>
  walk notes
    take n
    save last, spend(p)
  send back, last
`
refusedEverywhere('a permit spent inside a walk', 'sole-reused', {}, looped, ['walk may run its body twice'])

const perArm = `${PERMIT}
task pick
  take flag, like boolean
  like text
  save p, grant(<n1>)
  fork test, read flag
    hold
      send back, spend(p)
  send back
    call spend
      read p

task run
  like text
  send back, pick(true)
`
buildsEverywhere('a fork that spends the permit once per arm', {}, perArm)

const perArmThenAgain = `${PERMIT}
task pick
  take flag, like boolean
  like text
  save p, grant(<n1>)
  save a, <>
  fork test, read flag
    hold
      save a, spend(p)
    miss
      save a, spend(p)
  send back, spend(p)
`
refusedEverywhere('a spend after a fork that spent it in each arm', 'sole-reused', {}, perArmThenAgain, ['"p"'])

const fresh = `${PERMIT}
task run
  take notes, like list, like text
  like text
  save last, <none>
  walk notes
    take n
    save p, grant(n)
    save last, spend(p)
  send back, last
`
buildsEverywhere('a permit made and spent inside each turn of a walk', {}, fresh)

const generic = `${PERMIT}
task hoard
  take all, like list, like permit
  like number
  send back, 0
`
refusedEverywhere('a list of permits', 'sole-generic', {}, generic, ['permit'])

// ---- earned ----

const unearned = `${PERMIT}
form ticket
  link permit, like permit
  link seat, like text
`
refusedEverywhere('a form holding a permit without mark sole', 'sole-unearned', {}, unearned, ['"ticket"', '"permit"'])

const throughAnother = `${PERMIT}
form ticket
  mark sole
  link permit, like permit

form booking
  link ticket, like ticket
  link who, like text
`
refusedEverywhere('a form holding a sole form that holds a permit', 'sole-unearned', {}, throughAnother, ['"booking"'])

const earned = `${PERMIT}
form ticket
  mark sole
  link permit, like permit
  link seat, like text

task run
  like text
  send back, <ok>
`
buildsEverywhere('the same form with mark sole', {}, earned)

// ---- hide ----

const HIDDEN = `form permit
  mark hide
  mark sole
  link note, like text
  link person, like text

task grant-delete
  take person, like text
  take note, like text
  like permit
  send back
    make permit
      bind note, read note
      bind person, read person

task delete-note
  take permit, like permit
  like text
  send back, read permit/note
`

const forged = `load @app/permit
  find permit
  find delete-note

task erase
  like text
  send back
    call delete-note
      make permit
        bind note, <n1>
        bind person, <ada>
`
refusedEverywhere('a make of a hidden permit from another file', 'hidden-make', { '@app/permit': HIDDEN }, forged, ['"permit"', 'pkg/code/permit.tree'])

const asked = `load @app/permit
  find permit
  find grant-delete
  find delete-note

task run
  like text
  save p, grant-delete(<ada>, <n1>)
  send back, delete-note(p)
`
buildsEverywhere('another file that asks the declaring file for a permit and reads it', { '@app/permit': HIDDEN }, asked)

buildsEverywhere('a test file of the package that makes a permit', { '@app/permit': HIDDEN }, forged, '/pkg/test/permit.tree')

const HANDLE = `form handle
  mark hide
  case open
    link at, like text
  case shut
`
const forgedCase = `load @app/handle
  find handle

task forge
  like handle
  send back
    make open
      bind at, <x>
`
refusedEverywhere('a make of a case of a hidden form from another file', 'hidden-make', { '@app/handle': HANDLE }, forgedCase, ['"handle"'])

const axiom = `load @app/permit
  find permit

task conjure
  like permit
`
refusedEverywhere('a task with no body that answers a hidden form', 'hidden-make', { '@app/permit': HIDDEN }, axiom, ['"permit"'])

// ---- run the passing programs where the toolchains are ----

const dir = mkdtempSync(join(tmpdir(), 'term-sole-hide-'))

for (const backend of backends) {
  const ran = runOn({ backend, program: perArm, resolve: env => projectResolver(process.cwd(), env), dir, name: 'per-arm' })

  if (ran.form === 'skipped') {
    skip++
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(
    `${backend}: the per-arm program runs and spends its permit once`,
    ran.form === 'ran' && ran.output === 'n1',
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : `${ran.stage}: ${ran.reason}`,
  )
}

console.log(`\nsole-hide: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
