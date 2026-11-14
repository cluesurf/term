// A LOWERED CONSOLE OPENS ITS RUN THROUGH ITS ENTRY'S open-console (term/compiler decision 019, item
// term-self-host-001-1456). A probe console with three global takes (a text with a default, a boolean, a number with a
// default), a native verb (greet) and a forwarded one (host docks <node:os>) defines `open-console`, whose parameters
// name the takes, `mark` and `verb` in another order than the hook declares them. Built for Rust by this checkout's
// CLI: the emitted run calls open-console once, after the decision and before console-call, and only for the native
// verb; the binary prints open-console's line with each global's decided value, the deck's mark and the verb, then the
// verb's own line. Help, the version and a refusal never open, and neither does the forwarded verb. The same console
// with no open-console emits no call of it and none of the runtime's opening, and an open-console parameter that names
// nothing, or takes a type no converter gives, is refused at the build. A parameter named like a task the entry finds
// (mark) names nothing, so the verb taking it stays native, while a verb calling that task stays forwarded (item 1458).
// Its catch-console guards the native verb's call and answers a raise (item 1464, at the end).
// Run: npx tsx test/call/console-open.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const TERM = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const LINE = join(TERM, 'host', 'line.js')

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const HOOKS = `# The tool
hook tool
  # how the log is written
  take log
    like text
    bind <human>
  # no color or motion
  take plain
    like boolean
  # how much to say
  take level
    like number
    bind code 2

  # Greet someone
  hook greet
    # who to greet
    slot name
      like text
      need true
    task greet

  # Ask the node build
  hook host
    task host-name

load @term/call/work/item/emit
  find print-data

dock load
  load <node:os>, name os

task greet
  take name, like text
  like number

  call print-data, text <greet {name}\\n>
  send back, code 0

task host-name
  like number

  call os/hostname
  send back, code 4
`

// the parameters in another order than the hook's takes: they bind by name
const OPEN = `
task open-console
  take verb, like text
  take level, like number
  take mark, like text
  take plain, like boolean
  take log, like text

  call print-data, text <open verb={verb} level={level} mark={mark} plain={plain} log={log}\\n>
`

const out = mkdtempSync(join(tmpdir(), 'term-console-open-'))
const MARK = '3.4.5'

// one probe project, its console the text given, and any other files of its code
function project(name: string, console: string, others: Record<string, string> = {}): string {
  const root = join(out, name)
  mkdirSync(join(root, 'code'), { recursive: true })
  mkdirSync(join(root, 'link', '@term'), { recursive: true })
  writeFileSync(join(root, 'deck.tree'), `deck @probe/tool\n  mark <${MARK}>\n`)
  writeFileSync(join(root, 'code', 'base.tree'), console)
  for (const [file, text] of Object.entries(others)) writeFileSync(join(root, 'code', file), text)
  for (const one of ['base', 'call']) symlinkSync(join(TERM, 'deck', one), join(root, 'link', '@term', one))
  return root
}

const env: NodeJS.ProcessEnv = { ...process.env, NO_COLOR: '1' }
for (const name of ['TERM_DEPTH', 'TERM_LINE_NAME', 'TERM_LINE_LOCK', 'TERM_LINE_LOCK_BY', 'TERM_ROOT', 'TERM_STDLIB', 'FORCE_COLOR', 'CI'])
  delete env[name]

const tail = (r: { stdout: string; stderr: string }, size: number): string => `${r.stdout}${r.stderr}`.slice(-size)

function emit(root: string, file: string): { status: number | null; stdout: string; stderr: string; rust: string } {
  const made = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--out', file], { cwd: root, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  return { status: made.status, stdout: made.stdout ?? '', stderr: made.stderr ?? '', rust: made.status === 0 && existsSync(file) ? readFileSync(file, 'utf8') : '' }
}

// the body of the program's own `fn run` (a top-level `async fn run()`, never a runtime method of that name), up to the
// first line that closes it
const runOf = (rust: string): string => /^(?:async )?fn run\(\)[\s\S]*?\n\}/m.exec(rust)?.[0] ?? ''

// WITH open-console: the call is in run, once, after the decision and before console-call
const opened = project('opened', `${HOOKS}${OPEN}`)
const withOpen = emit(opened, join(out, 'opened.rs'))
ok('opened: term make --emit rust writes the console', withOpen.status === 0, tail(withOpen, 4000))
if (withOpen.status === 0) {
  const run = runOf(withOpen.rust)
  const calls = run.match(/\bopen_console\(/g) ?? []
  ok('opened: run calls open_console once', calls.length === 1, run.slice(0, 1500))
  const decide = run.indexOf('console_decide(')
  const opening = run.indexOf('console_opening(')
  const open = run.indexOf('open_console(')
  const call = run.indexOf('console_call(')
  ok('opened: the order is console_decide, console_opening, open_console, console_call', decide >= 0 && decide < opening && opening < open && open < call, `${decide} ${opening} ${open} ${call}`)
  // only the native verb's name guards the opening: the forwarded host-name never opens
  const guard = run.slice(0, Math.max(0, opening))
  ok('opened: the opening is guarded by the native verb greet only', /"greet"/.test(guard) && !/"host-name"/.test(guard), guard.slice(-600))
}

// WITHOUT it: no call, and the runtime's opening is shaken out
const plain = project('plain', HOOKS)
const withoutOpen = emit(plain, join(out, 'plain.rs'))
ok('plain: term make --emit rust writes the console', withoutOpen.status === 0, tail(withoutOpen, 4000))
if (withoutOpen.status === 0) {
  ok('plain: no open_console anywhere', !/\bopen_console\b/.test(withoutOpen.rust))
  ok('plain: no console_opening anywhere (the runtime\'s opening is shaken out)', !/\bconsole_opening\b|\bdecide_opening\b/.test(withoutOpen.rust))
}

// A PARAMETER NAMED LIKE A FIND NAMES NOTHING (term/compiler decision 020, item term-self-host-001-1458). The entry
// finds a task `mark` that docks <node:os> (so it is never native) under another name, as the Term CLI's line/base.tree
// finds its mark verb (`find mark, name mark-verb`). open-console takes `mark`, and so does the verb sign: each reads its
// own parameter, never the found task, so sign stays native and the console builds. The verb stamp CALLS the found task,
// so it stays forwarded (no under-taint)
const MARKING = `dock load
  load <node:os>, name os

task mark
  like number

  call os/hostname
  send back, code 5
`
const SHADOW_HOOKS = HOOKS.replace(`  # Ask the node build
  hook host`, `  # Sign with a mark
  hook sign
    # the mark to sign with
    slot mark
      like text
      need true
    task sign

  # Stamp through the found task
  hook stamp
    task stamp

  # Ask the node build
  hook host`).replace(`dock load
  load <node:os>, name os
`, `load ./marking
  find mark, name mark-verb

dock load
  load <node:os>, name os
`) + `
task sign
  take mark, like text
  like number

  call print-data, text <sign {mark}\\n>
  send back, code 0

task stamp
  like number

  call mark-verb
  send back, code 0
`
const shadowed = project('shadowed', `${SHADOW_HOOKS}${OPEN}`, { 'marking.tree': MARKING })
const withShadow = emit(shadowed, join(out, 'shadowed.rs'))
ok('shadowed: term make --emit rust writes the console (open-console\'s mark names no found task)', withShadow.status === 0, tail(withShadow, 4000))
if (withShadow.status === 0) {
  const run = runOf(withShadow.rust)
  const guard = run.slice(0, Math.max(0, run.indexOf('console_opening(')))
  ok('shadowed: the verb sign, whose parameter is mark, is native (it guards the opening)', /"sign"/.test(guard), guard.slice(-600))
  ok('shadowed: the verb stamp, which calls the found task, never guards the opening', !/"stamp"/.test(guard), guard.slice(-600))
  const record = /CONSOLE_FORWARDED[\s\S]{0,400}?\]/.exec(withShadow.rust)?.[0] ?? ''
  const forwarded = [...record.matchAll(/"([^"]*)"/g)].map(m => m[1]).sort()
  ok('shadowed: console-forwarded names stamp and host, never sign or greet', forwarded.join(',') === 'tool host,tool stamp', record.slice(0, 400))
}

// REFUSED: a parameter that names nothing, and one whose type no converter gives
for (const [name, extra, said] of [
  ['names nothing', '\ntask open-console\n  take color, like text\n\n  call print-data, text <{color}>\n', /color, which names no take of the program hook/],
  ['no converter', '\ntask open-console\n  take level, like list, like number\n\n  call print-data, text <{level/length}>\n', /takes the program's level as a type no console conversion gives/],
  ['mark not text', '\ntask open-console\n  take mark, like number\n\n  call print-data, text <{mark}>\n', /takes mark as a type other than text/],
] as const) {
  const root = project(`refused-${name.replace(/ /g, '-')}`, `${HOOKS}${extra}`)
  const made = emit(root, join(out, `refused-${name.replace(/ /g, '-')}.rs`))
  ok(`refused (${name}): the build fails`, made.status !== 0, tail(made, 1500))
  // the printer wraps a long message: read it with every run of white space as one space
  ok(`refused (${name}): it says why`, said.test(`${made.stdout}${made.stderr}`.replace(/\s+/g, ' ')), tail(made, 1500))
}

// THE RUN: built with cargo, the opening line before the verb's, with the decided globals
const cargo = spawnSync('cargo', ['--version'], { encoding: 'utf8' })
if (cargo.status !== 0) {
  console.log('skip  the probe build and its runs  (cargo not installed)')
} else {
  const built = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--build', '--out', join(out, 'rust')], { cwd: opened, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  ok('opened: term make --emit rust --build builds the console', built.status === 0, tail(built, 6000))
  let tool: string | undefined
  if (built.status === 0) {
    const files = readdirSync(join(out, 'rust'))
    const isBin = (f: string): boolean => existsSync(f) && statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0 && !/\.(rs|d|toml)$/.test(f)
    const cargoBins = files.filter(f => f.endsWith('-cargo')).map(f => join(out, 'rust', f, 'target', 'release', f.slice(0, -6)))
    tool = [...files.map(f => join(out, 'rust', f)), ...cargoBins].find(isBin)
    ok('opened: the build leaves a binary', tool !== undefined, files.join(', '))
  }
  if (tool) {
    const cwd = join(out, 'cwd')
    mkdirSync(cwd, { recursive: true })
    const runs: { words: string[]; code: number; out: string }[] = [
      { words: ['greet', 'bob'], code: 0, out: `open verb=greet level=2 mark=${MARK} plain=false log=human\ngreet bob\n` },
      // a global after the command: the console runtime's parse (work/hook/route-parsing.tree parse-line) reads a flag
      // before the command as the end of the command's words
      { words: ['greet', 'al', '--log', 'json', '--plain', '--level', '5'], code: 0, out: `open verb=greet level=5 mark=${MARK} plain=true log=json\ngreet al\n` },
      { words: ['greet', 'cy', '--log', 'json'], code: 0, out: `open verb=greet level=2 mark=${MARK} plain=false log=json\ngreet cy\n` },
      { words: ['--version'], code: 0, out: `${MARK}\n` },
    ]
    for (const one of runs) {
      const ran = spawnSync(tool, one.words, { cwd, encoding: 'utf8', env })
      ok(`run: tool ${one.words.join(' ')} exits ${one.code}`, ran.status === one.code, `exit ${ran.status} ${JSON.stringify(ran.stderr.slice(0, 400))}`)
      ok(`run: tool ${one.words.join(' ')} prints open-console's line, then the verb's`, ran.stdout === one.out, JSON.stringify(ran.stdout))
    }
    // never opened: help, a refusal, and the forwarded verb (its node build is not there, so it fails, unopened)
    for (const words of [['--help'], ['greet'], ['frobnicate'], ['host']]) {
      const ran = spawnSync(tool, words, { cwd, encoding: 'utf8', env })
      ok(`run: tool ${words.join(' ')} never opens`, !/\bopen verb=/.test(`${ran.stdout}${ran.stderr}`), JSON.stringify(ran.stdout.slice(0, 300)))
    }
  }
}

// A LOWERED CONSOLE CATCHES A RAISE THROUGH ITS ENTRY'S catch-console (term/compiler decision 021 points 6 to 9, item
// term-self-host-001-1464). The probe's greet raises a failure for `fail` and a defect for `defect`. CAUGHT's
// catch-console prints what it is handed (parameters in another order than the decision names them), and PRINTED's
// answers as the Term CLI's does (line/base.tree catch-console): through the printer's fail-typed-run, a failure as
// node's fail-run prints it (`✗ term <note>`, `✗ term Failed`, exit 1) and a defect as a bug in Term (the crash item, a
// crash log under the working folder, exit 70). Only the native verb is guarded: the forwarded host-name never is.
const RAISING = HOOKS.replace(`task greet
  take name, like text
  like number

  call print-data`, `load @term/base/exception
  find defect

task greet
  take name, like text
  like number

  fork test
    hook test
      call is-equal
        read name
        text <defect>
    hook hold
      halt defect
        bind thing, <probe>
  fork test
    hook test
      call is-equal
        read name
        text <fail>
    hook hold
      halt <probe failure>
  call print-data`)
const CAUGHT = `
task catch-console
  take stack, like text
  take verb, like text
  take note, like text
  take form, like text
  take mark, like text
  like number

  call print-data, text <caught verb={verb} form={form} mark={mark} note={note}\\n{stack}\\n>
  send back, code 7
`
const PRINTED = `
load @term/call/work/output/printer
  find is-bug-form
  find fail-typed-run
  find write-typed-crash-log
  find show-path

load @term/base/environment
  find current-directory

task catch-console
  take note, like text
  take form, like text
  take stack, like text
  like number
  save bug
    call is-bug-form
      read form
  save shown, text <>
  fork test
    hook test
      read bug
    hook hold
      save root
        call current-directory
      save log
        call write-typed-crash-log
          read stack
          read root
      fork test
        hook test
          call is-unequal
            read log
            text <>
        hook hold
          save shown
            call show-path
              read log
              read root
  save quote
    make list
  send back
    call fail-typed-run
      read note
      text <>
      read bug
      read quote
      read shown
`
ok('raising: the probe greet raises (the console text was rewritten)', RAISING !== HOOKS)
const caught = project('caught', `${RAISING}${CAUGHT}`)
const withCatch = emit(caught, join(out, 'caught.rs'))
ok('caught: term make --emit rust writes the console', withCatch.status === 0, tail(withCatch, 4000))
if (withCatch.status === 0) {
  const run = runOf(withCatch.rust)
  ok('caught: run calls catch_console once', (run.match(/\bcatch_console\(/g) ?? []).length === 1, run.slice(0, 2000))
  // the guarded call and the forwarded one: console_call twice, the guard naming greet and never host-name
  ok('caught: run calls console_call twice (guarded for greet, plain for a forwarded verb)', (run.match(/\bconsole_call\(/g) ?? []).length === 2, run.slice(0, 2000))
  const head = run.slice(0, Math.max(0, run.indexOf('catch_console(')))
  ok('caught: the guard is chosen by the native verb greet only', /"greet"/.test(head) && !/"host-name"/.test(head), head.slice(-800))
}
// a raise in a console with no catch-console still reaches the runtime's unhandled answer
const uncaught = project('uncaught', RAISING)
const withoutCatch = emit(uncaught, join(out, 'uncaught.rs'))
ok('uncaught: term make --emit rust writes the console', withoutCatch.status === 0, tail(withoutCatch, 4000))
if (withoutCatch.status === 0) ok('uncaught: no catch_console anywhere', !/\bcatch_console\b/.test(withoutCatch.rust))
const printed = project('printed', `${RAISING}${PRINTED}`)
const withPrinted = emit(printed, join(out, 'printed.rs'))
ok('printed: term make --emit rust writes the console with the printer\'s answer', withPrinted.status === 0, tail(withPrinted, 4000))

// REFUSED: a catch-console parameter that names nothing, one of another type, an answer that is no number
for (const [name, extra, said] of [
  ['catch names nothing', '\ntask catch-console\n  take color, like text\n  like number\n\n  send back, code 1\n', /catch-console has a parameter color, which is not note, form, stack, mark or verb/],
  ['catch note not text', '\ntask catch-console\n  take note, like number\n  like number\n\n  send back, code 1\n', /catch-console takes note as a type other than text/],
  ['catch answers no number', '\ntask catch-console\n  take note, like text\n  like text\n\n  send back, read note\n', /catch-console answers something other than a number/],
] as const) {
  const root = project(`refused-${name.replace(/ /g, '-')}`, `${RAISING}${extra}`)
  const made = emit(root, join(out, `refused-${name.replace(/ /g, '-')}.rs`))
  ok(`refused (${name}): the build fails`, made.status !== 0, tail(made, 1500))
  ok(`refused (${name}): it says why`, said.test(`${made.stdout}${made.stderr}`.replace(/\s+/g, ' ')), tail(made, 1500))
}

// the binary of a probe, built with cargo, or undefined when it does not build
function binaryOf(root: string, folder: string): string | undefined {
  const built = spawnSync('node', [LINE, 'make', 'code/base.tree', '--emit', 'rust', '--build', '--out', join(out, folder)], { cwd: root, encoding: 'utf8', env, maxBuffer: 1 << 26 })
  ok(`${folder}: term make --emit rust --build builds the console`, built.status === 0, tail(built, 6000))
  if (built.status !== 0) return undefined
  const files = readdirSync(join(out, folder))
  const isBin = (f: string): boolean => existsSync(f) && statSync(f).isFile() && (statSync(f).mode & 0o111) !== 0 && !/\.(rs|d|toml)$/.test(f)
  const cargoBins = files.filter(f => f.endsWith('-cargo')).map(f => join(out, folder, f, 'target', 'release', f.slice(0, -6)))
  return [...files.map(f => join(out, folder, f)), ...cargoBins].find(isBin)
}

if (cargo.status === 0) {
  const caughtTool = binaryOf(caught, 'caught-rust')
  if (caughtTool) {
    const cwd = join(out, 'caught-cwd')
    mkdirSync(cwd, { recursive: true })
    const greeted = spawnSync(caughtTool, ['greet', 'bob'], { cwd, encoding: 'utf8', env })
    ok('caught run: tool greet bob is not caught', greeted.status === 0 && greeted.stdout === 'greet bob\n', `exit ${greeted.status} ${JSON.stringify(greeted.stdout)}`)
    for (const [word, form, note] of [['fail', 'failure', 'probe failure'], ['defect', 'defect', 'Invalid']] as const) {
      const ran = spawnSync(caughtTool, ['greet', word], { cwd, encoding: 'utf8', env })
      ok(`caught run: tool greet ${word} exits catch-console's answer, 7`, ran.status === 7, `exit ${ran.status} ${JSON.stringify(ran.stderr.slice(0, 400))}`)
      const first = `caught verb=greet form=${form} mark=${MARK} note=${note}\n${form}: ${note}\n`
      ok(`caught run: tool greet ${word} hands the verb, form, mark, note and the stack's first line`, ran.stdout.startsWith(first), JSON.stringify(ran.stdout.slice(0, 600)))
      // the stack's frames, one `  at <task> <file>:<line>` line each, greet's among them
      const frames = ran.stdout.slice(first.length).split('\n').filter(line => line !== '')
      ok(`caught run: tool greet ${word} hands the stack's frames as __term_unhandled prints them`, frames.length >= 1 && frames.every(line => /^ {2}at \S+ \S+:\d+$/.test(line)) && frames.some(line => /^ {2}at greet /.test(line)), JSON.stringify(frames))
    }
  }
  const printedTool = binaryOf(printed, 'printed-rust')
  if (printedTool) {
    const cwd = join(out, 'printed-cwd')
    mkdirSync(cwd, { recursive: true })
    const failed = spawnSync(printedTool, ['greet', 'fail'], { cwd, encoding: 'utf8', env })
    const failedText = `${failed.stdout}${failed.stderr}`
    ok('printed run: a raised failure exits 1, as node\'s fail-run', failed.status === 1, `exit ${failed.status} ${JSON.stringify(failedText.slice(0, 600))}`)
    ok('printed run: a raised failure prints `✗ term probe failure` then `✗ term Failed`, as node\'s fail-run', /✗ term probe failure\n✗ term Failed\n/.test(failedText) && !/internal error/.test(failedText), JSON.stringify(failedText.slice(0, 600)))
    const crashed = spawnSync(printedTool, ['greet', 'defect'], { cwd, encoding: 'utf8', env })
    const crashedText = `${crashed.stdout}${crashed.stderr}`
    ok('printed run: a raised defect exits 70, a bug in Term as node\'s fail-run judges it', crashed.status === 70, `exit ${crashed.status} ${JSON.stringify(crashedText.slice(0, 600))}`)
    ok('printed run: a raised defect prints the crash item and closes `Stopped by an internal error`', /✗ term Term stopped on an internal error: Invalid\n/.test(crashedText) && /log \.term\/crash-\S+\.log/.test(crashedText) && /✗ term Stopped by an internal error\n/.test(crashedText), JSON.stringify(crashedText.slice(0, 800)))
    const logs = existsSync(join(cwd, '.term')) ? readdirSync(join(cwd, '.term')).filter(f => /^crash-\d{4}-\d\d-\d\dT\d\d-\d\d-\d\d-\d{3}Z\.log$/.test(f)) : []
    const logText = logs.length === 1 ? readFileSync(join(cwd, '.term', logs[0] ?? ''), 'utf8') : ''
    ok('printed run: the defect wrote one crash log holding the stack', logs.length === 1 && logText.startsWith('defect: Invalid\n  at '), `${logs.join(', ')} ${JSON.stringify(logText.slice(0, 300))}`)
  }
}

rmSync(out, { recursive: true, force: true })

console.log(`\nconsole-open: ${pass} pass, ${fail} fail`)

if (fail > 0 || pass === 0) {
  process.exitCode = 1
}
