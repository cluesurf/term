// The CLI's side of the terminal output library (code/work/item/, note/term/output/readme.md): the one run a command
// prints through, the global flags of sections 18 and 20, and the compiler's diagnostics as Problem items (section 12).
//
// TypeScript, not Term, because it is GLUE between two things that are TypeScript today: yargs, which parses the
// flags, and the compiler's `Diagnostic`, which it converts. It draws nothing and decides nothing the standard
// decides: every line comes from the `.tree` library, and this only holds the runner for the process and builds
// events. When the commands move to Term this file goes with them.
//
// A COMMAND NEVER WRITES TO STDOUT OR STDERR. It calls `openRun` once, `report` (or `reportProblem`) per event and
// `closeRun` at the end, which sets the exit code. `printData` is the one way to put data the user asked for on
// stdout. test/call/output-only.ts fails the build when a command writes any other way.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'
import type { ChildProcess } from 'node:child_process'
import type { Readable } from 'node:stream'
import { beginRun, endRun, printData as printDataOut, report as reportOut } from '@term/call/code/work/item/emit'
// the port's module whole, for a task read at CALL time: task/port-build.ts loads this file while it is building that
// port, so a name new to emit.tree cannot be a static import here, or the build that would make it refuses to start
import * as emitPort from '@term/call/code/work/item/emit'
import { adaptLine } from '@term/call/code/work/item/adapt'
import type { Runner } from '@term/call/code/work/item/emit'
import { arrangeProblems, makeOpening, makeOptions, makeCrash } from '@term/call/code/work/item/run'
import type { RunOptions } from '@term/call/code/work/item/run'
import { blankEvent, plainField, plainSubject } from '@term/call/code/work/item/event'
import type { Event, Frame, ItemField, Tally } from '@term/call/code/work/item/event'
import { makeStandard } from '@term/call/code/work/item/standard'
import { formatPath } from '@term/call/code/work/item/format'
import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'

const STANDARD = makeStandard()

// the global flags, as yargs hands them over. Every one is optional: a command run with none prints as section 18
// says by default
export type OutputFlags = {
  quiet?: boolean
  verbose?: boolean
  trace?: boolean
  log?: string
  color?: string
  utc?: boolean
  plain?: boolean
  strict?: boolean
  motion?: boolean
  yes?: boolean
  raw?: boolean
  source?: string
  all?: boolean
}

let options: RunOptions = makeOptions()
// `--all`: no cap on problems. The `… n more problems` item names it, and until 2026-10-04 nothing read it
let showAll = false
let version = ''
let runner: Runner | undefined
let started = 0
let verb = ''
// how deep in other runs this process's run is (section 15), passed to every child, and what it was before the run opened
const DEPTH_VARIABLE = 'TERM_DEPTH'
let outerDepth: string | undefined

// the flags, read once before any command runs (line.ts, a yargs middleware), the tool's version for the opening item,
// and the command's own verb (`argv._[0]`), so a failure before the command opens its run is still under its verb
export function setOutput(flags: OutputFlags & { _?: (string | number)[] }, toolVersion: string): void {
  version = toolVersion
  showAll = flags.all ?? false

  if (!verb && flags._ && flags._.length > 0) {
    verb = String(flags._[0])
  }

  options = {
    ...makeOptions(),
    quiet: flags.quiet ?? false,
    verbose: flags.verbose ?? false,
    trace: flags.trace ?? false,
    json: flags.log === 'json',
    color: flags.color === 'always' || flags.color === 'never' ? flags.color : 'auto',
    utc: flags.utc ?? false,
    plain: flags.plain ?? false,
    strict: flags.strict ?? false,
    // yargs reads `--no-motion` as `motion: false`
    motion: flags.motion ?? true,
    yes: flags.yes ?? false,
    raw: flags.raw ?? false,
    source: flags.source ?? '',
  }
}

export function outputOptions(): RunOptions {
  return options
}

// ---- events ----

export type ItemInput = {
  glyph?: string
  kind?: string
  verb?: string
  subject?: string
  source?: string
  // epoch milliseconds, now when left out
  clock?: number
  duration?: number
  budget?: number
  http?: number
  exit?: number
  bytes?: number
  counts?: Tally[]
  facts?: string[]
  message?: string[]
  fields?: ItemField[]
  frames?: Frame[]
  quote?: string[]
  done?: number
  total?: number
  level?: string
  place?: { path: string; line: number; column: number }
}

// an event from what a command has. Every quantity stays a number: the library formats it
export function makeItem(input: ItemInput): Event {
  const one: Event = { ...blankEvent(), glyph: input.glyph ?? 'info', clock: input.clock ?? Date.now() }

  if (input.kind !== undefined) one.kind = input.kind
  if (input.verb !== undefined) one.verb = input.verb
  if (input.subject !== undefined) one.subject = plainSubject(input.subject)
  if (input.source !== undefined) one.source = input.source
  if (input.duration !== undefined) one.duration = input.duration
  if (input.budget !== undefined) one.budget = input.budget
  if (input.http !== undefined) one.status = { kind: 'http', value: input.http, name: '' }
  if (input.exit !== undefined) one.status = { kind: 'exit', value: input.exit, name: '' }
  if (input.bytes !== undefined) one.bytes = input.bytes
  if (input.counts !== undefined) one.tallies = input.counts
  if (input.facts !== undefined) one.facts = input.facts
  if (input.message !== undefined) one.message = input.message
  if (input.fields !== undefined) one.fields = input.fields
  if (input.frames !== undefined) one.frames = input.frames
  if (input.quote !== undefined) one.quote = input.quote
  if (input.done !== undefined) one.done = input.done
  if (input.total !== undefined) one.total = input.total
  if (input.level !== undefined) one.level = input.level
  if (input.place !== undefined) one.place = input.place

  return one
}

// a count: number then noun (`42 files`), or part of a total (`31/46 files`). `one` is the singular beside 1
export function count(amount: number, noun: string, one = '', total = -1): Tally {
  return { amount, noun, one, total }
}

// a field of section 7
export function field(key: string, value: string): ItemField {
  return plainField(key, value)
}

// a location field, `at`, which breaks only after `/` and links to its file
export function location(where: string): ItemField {
  return { ...plainField(STANDARD.fields.locationKey, where), location: true }
}

// ---- the run ----

// a path as the human view prints it: relative to the root, `~` for home (section 6)
export function showPath(where: string, root = ''): string {
  return formatPath(where, root, homedir())
}

// the opening item: the command's verb, the working directory or project root, the tool and version, and up to three
// context counts (section 3)
// (`started`: when the work began, for a run that opens its item only after it, as `term hunt` does while its fuzz
// children own the terminal. The opening clock and the closing total are then the work's, not the print's)
export function openRun(input: { verb: string; root: string; subject?: string; counts?: Tally[]; facts?: string[]; tool?: string; started?: number }): void {
  verb = input.verb
  started = input.started ?? Date.now()
  // section 15: a run started by a command of another Term run is drawn under that run's elbow. The depth comes in through
  // the environment, and every child this run starts while it is open is one level deeper
  const depth = Math.max(0, Number(process.env[DEPTH_VARIABLE] ?? 0) || 0)
  outerDepth = process.env[DEPTH_VARIABLE]
  options = { ...options, depth }
  process.env[DEPTH_VARIABLE] = String(depth + 1)
  const opening = makeOpening(input.verb, input.subject ?? showPath(input.root), started, input.tool ?? (version ? `term ${version}` : 'term'))
  opening.tallies = input.counts ?? []
  opening.facts = input.facts ?? []
  runner = beginRun(input.verb, opening, options, STANDARD)
}

export function isRunOpen(): boolean {
  return runner !== undefined
}

// one event, printed as the flags say. A command that reports before opening a run gets one opened for it
export function report(input: ItemInput | Event): void {
  if (!runner) {
    openRun({ verb: verb || 'term', root: process.cwd() })
  }

  const event = 'tallies' in input ? (input as Event) : makeItem(input as ItemInput)
  runner = reportOut(runner!, event.verb === '' ? { ...event, verb } : event)
}

// the closing item: the verdict, the total time and the counts, a `next` field when there is one. The glyph is the
// worst of the run, and the exit code follows it (section 18). `failure` is <usage>, <environment>, <bug> or
// <interrupted> when the run ends for that reason. Sets process.exitCode, and returns it
// (`done`: the run did its work through change items, `+ − ~`, which rank below ✓ in section 4's order, so a wash
// that removed three folders would close `·`, the glyph of a run that did nothing. With it, the closing is ✓ unless
// something worse happened. A plan that only says what it WOULD change leaves it off and closes `·`)
export function closeRun(input: { verdict: string; counts?: Tally[]; facts?: string[]; message?: string[]; next?: string; failure?: string; uptime?: boolean; done?: boolean }): number {
  if (!runner) {
    openRun({ verb: verb || 'term', root: process.cwd() })
  }

  const now = Date.now()
  // under --strict a run whose worst item is a warning closes ✗ and exits 1 (section 18), whatever its verdict says
  // ("1 file built"): the closing says why, so the glyph and the verdict do not seem to disagree
  const strictly = options.strict && !input.failure && runner?.session.worstGlyph === 'warning' ? ['Warnings fail the run under --strict.'] : []
  const closing = makeItem({ verb, subject: input.verdict, clock: now, duration: now - started, counts: input.counts, facts: input.facts, message: [...(input.message ?? []), ...strictly] })
  closing.uptime = input.uptime ?? false

  if (input.next) {
    closing.fields = [field(STANDARD.fields.nextKey, input.next)]
  }

  let one = runner!
  const doneRank = STANDARD.glyphs.find(glyph => glyph.name === 'done')?.rank ?? 0

  if (input.done && one.session.worst < doneRank) {
    one = { ...one, session: { ...one.session, worst: doneRank, worstGlyph: 'done' } }
  }

  if (input.failure) {
    one = { ...one, session: { ...one.session, failure: input.failure } }
  }

  const code = endRun(one, closing)
  runner = undefined
  process.exitCode = code

  // what starts after the run is closed is not inside it: `term boot` runs its program once its own run is over
  if (outerDepth === undefined) {
    delete process.env[DEPTH_VARIABLE]
  } else {
    process.env[DEPTH_VARIABLE] = outerDepth
  }

  return code
}

// data the user asked for, on stdout, as it is
export function printData(value: string): void {
  // the blank line after the opening is owed to the first thing under it, and data on the same terminal is that
  // thing: `term look` drew its table directly under the opening item (guides: commands/look, 2026-10-04). Paid on
  // stderr, and only when both streams are the terminal, so a pipe never gets a line it did not ask for
  if (runner?.session.owed && process.stdout.isTTY && process.stderr.isTTY) {
    process.stderr.write('\n')
    runner = { ...runner, session: { ...runner.session, owed: false } }
  }

  // section 15: after an item, on the terminal the run is on, data hangs under that item's elbow so the run keeps its left
  // edge (`term self load` prints the `export PATH=...` line it names). A pipe, `--log json` and `--plain` get it as it is
  if (runner && runner.session.printed > 0 && process.stdout.isTTY && process.stderr.isTTY && !options.json && !options.plain) {
    emitPort.printDataUnder(runner, value)

    return
  }

  printDataOut(value)
}

// ---- a child process ----

// a toolchain step run for its result (a compiler, a linker, a signer, a device bridge): its output is the TOOL's,
// so it is never mixed into the run's own lines (section 15). On success it is kept out of the way and the stdout is
// handed back. On failure the step throws an error that names the tool and its exit, carrying the output as `quote`,
// which `failRun` draws under the ✗ item. A tool that is not installed is `environment`, exit 3. Under `--raw` the
// tool writes to the terminal as it runs, as it always did
export function runTool(cmd: string, args: string[], spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): string {
  if (options.raw) {
    execFileSync(cmd, args, { ...spawnOptions, stdio: 'inherit' })

    return ''
  }

  try {
    return execFileSync(cmd, args, { ...spawnOptions, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 })
  } catch (error) {
    const failed = error as { status?: number | null; signal?: string | null; stdout?: string; stderr?: string; code?: string }
    const missing = failed.code === 'ENOENT'
    const name = path.basename(cmd)
    const quote = `${failed.stdout ?? ''}${failed.stderr ?? ''}`.split('\n').filter(line => line.trim() !== '')

    throw Object.assign(
      new Error(missing ? `${name} is not installed, or not on the PATH` : `${name} ${failed.signal ? `stopped on ${failed.signal}` : `exited ${failed.status ?? 1}`}`),
      { expected: true, quote, failure: missing ? 'environment' : undefined },
    )
  }
}

// a running child's output, line by line, as section 15 says: a JSON line or a logfmt line is ADAPTED into an item
// (level the glyph, logger the verb, msg the subject, time the clock, and the rest fields or facts), and PLAIN text is
// QUOTED, under one `log` item tagged with the child's source: a burst of plain lines is one quote, closed when the
// child pauses for the standard's quiet moment, when an adapted line arrives, or when the stream ends, so nothing it
// writes is mixed in as the tool's own and a ten-line banner is one item rather than ten. Under `--raw` every line
// passes through untouched, stdout to stdout, stderr to stderr. The child is spawned with stdout and stderr PIPED
const QUOTE_PAUSE_MS = 50

export function followChild(child: ChildProcess, source: string): void {
  let pending: string[] = []
  let timer: ReturnType<typeof setTimeout> | undefined

  const flush = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = undefined
    }

    if (pending.length === 0) {
      return
    }

    const quote = pending
    pending = []
    report({ glyph: 'info', verb: STANDARD.children.defaultVerb, subject: source, quote })
  }

  const take = (line: string, fromError: boolean): void => {
    if (options.raw) {
      ;(fromError ? emitPort.printRawError : printDataOut)(`${line}\n`)

      return
    }

    if (line.trim() === '') {
      return
    }

    if (!runner) {
      openRun({ verb: verb || 'term', root: process.cwd() })
    }

    const room = runner!.output.room
    const adapted = adaptLine(line, Date.now(), room.offset, false, room)

    if (adapted.kind === 'item') {
      flush()
      report({ ...adapted.event, source })

      return
    }

    pending.push(line)

    if (timer) {
      clearTimeout(timer)
    }

    timer = setTimeout(flush, QUOTE_PAUSE_MS)
  }

  child.on('close', flush)

  const follow = (stream: Readable | null, fromError: boolean): void => {
    let partial = ''

    stream?.on('data', (chunk: Buffer) => {
      const lines = `${partial}${chunk.toString('utf8')}`.split('\n')
      partial = lines.pop() ?? ''

      for (const line of lines) {
        take(line.replace(/\r$/, ''), fromError)
      }
    })
    stream?.on('end', () => {
      if (partial !== '') {
        take(partial, fromError)
        partial = ''
      }
    })
  }

  follow(child.stdout, false)
  follow(child.stderr, true)
}

// ---- problems ----

// a source location as `path:line:col`, 1-based, relative to the root
function placeOf(file: string, span: Span, root: string): string {
  return `${showPath(file, root)}:${span.start.line + 1}:${span.start.column + 1}`
}

function sourceLines(file: string, text: string | undefined): string[] {
  if (text !== undefined) {
    return text.split('\n')
  }

  try {
    return readFileSync(file, 'utf8').split('\n')
  } catch {
    return []
  }
}

// the code frame of a diagnostic: the primary span's line with one line of context before it when that line has
// text, and the line of every related marker, `⋮` between lines that are not adjacent (section 7)
function frameOf(diagnostic: Diagnostic, lines: string[]): Frame | undefined {
  if (lines.length === 0) {
    return undefined
  }

  const marks: Frame['marks'] = []
  const shown = new Set<number>()
  const add = (span: Span, label: string, primary: boolean): void => {
    const line = span.start.line
    const text = lines[line]

    if (text === undefined) {
      return
    }

    const stop = span.end.line === line ? span.end.column : text.length
    marks.push({ line: line + 1, column: span.start.column + 1, length: Math.max(1, stop - span.start.column), label, primary })
    shown.add(line)
  }

  add(diagnostic.span, diagnostic.markers[0]?.label ?? '', true)

  // the related markers live in this file only when their span says so, or says nothing
  for (const marker of diagnostic.markers.slice(1)) {
    if (!marker.span.file || marker.span.file === diagnostic.file) {
      add(marker.span, marker.label ?? '', false)
    }
  }

  const before = diagnostic.span.start.line - 1

  if (before >= 0 && (lines[before] ?? '').trim() !== '' && marks.length === 1) {
    shown.add(before)
  }

  return {
    lines: [...shown].sort((a, b) => a - b).map(line => ({ number: line + 1, value: lines[line] ?? '' })),
    marks,
    tabWidth: STANDARD.frames.tabWidth,
  }
}

// a diagnostic as a Problem item (section 12): the message is the subject, the location an `at` field, the source a
// code frame, the hint a `next` field. A proof obligation's verb is `prove`, everything else `check`
export function problemOf(diagnostic: Diagnostic, root: string, text?: string): Event {
  const glyph = diagnostic.severity === 'error' ? 'failed' : diagnostic.severity === 'warning' ? 'warning' : 'info'
  const proof = /proof|proven|hold|claim|obligation/.test(diagnostic.name)
  const fields: ItemField[] = [location(placeOf(diagnostic.file, diagnostic.span, root))]

  if (diagnostic.hint) {
    fields.push(field(STANDARD.fields.nextKey, diagnostic.hint))
  }

  const frame = frameOf(diagnostic, sourceLines(diagnostic.file, text))
  // a message of several lines keeps its breaks (section 7): the first line is the subject, the rest message lines.
  // The kernel's mismatch is two lines on purpose, what was expected over what was found
  const [first = '', ...rest] = diagnostic.message.split('\n')
  // capital first, unless the message opens with a path or a name, which is written as it is (`mod-both/code/x.tree`)
  // the first word without the punctuation a sentence puts after it (`kernel:` is a word, `a/b.tree` a path)
  const opening = (first.split(' ')[0] ?? '').replace(/[:,;.]+$/, '')
  const subject = /[/.:\\@`"<]/.test(opening) ? first : first.charAt(0).toUpperCase() + first.slice(1)

  return makeItem({
    glyph,
    kind: 'problem',
    verb: proof ? 'prove' : 'check',
    // the subject is a sentence, capital first (section 7); the compiler writes its messages starting lowercase
    subject,
    message: rest.map(line => line.trim()).filter(line => line !== ''),
    // the name, and a lint rule's stable code beside it (`prefer-host-for-constant L004`), which is what
    // `# lint off` takes, so a reader learns from the run what to write
    facts: [(diagnostic as { rule?: string }).rule ? `${diagnostic.name} ${(diagnostic as { rule?: string }).rule}` : diagnostic.name],
    fields,
    frames: frame ? [frame] : [],
    place: { path: showPath(diagnostic.file, root), line: diagnostic.span.start.line + 1, column: diagnostic.span.start.column + 1 },
  })
}

export function reportProblem(diagnostic: Diagnostic, root: string, text?: string): void {
  report(problemOf(diagnostic, root, text))
}

// a batch of diagnostics as section 12 prints them: sorted by path, line and column, one caused by an earlier one
// hidden, and past the standard's cap one `… n more problems` item. A line with no diagnostic behind it (`faults`)
// is a problem item of its own, after them
export function reportProblems(list: { diagnostic: Diagnostic; text?: string }[], root: string, faults: string[] = []): void {
  if (!runner) {
    openRun({ verb: verb || 'term', root })
  }

  // ONE item per problem: a diagnostic in a module several entries load comes back once per entry, and the build
  // printed a stdlib module's two errors four times each. The same file, place, name and message is the same problem
  const seen = new Set<string>()
  const unique = list.filter(each => {
    const d = each.diagnostic
    const key = `${d.file}:${d.span.start.line}:${d.span.start.column}:${d.name}:${d.message}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })

  const standard = showAll ? { ...STANDARD, caps: { ...STANDARD.caps, problems: 0 } } : STANDARD

  for (const one of arrangeProblems(unique.map(each => problemOf(each.diagnostic, root, each.text)), standard, runner!.output.room)) {
    report(one)
  }

  for (const fault of faults) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: fault })
  }
}

// ---- a failure nobody caught ----

// a thrown error ends the run: its message as a ✗ item and the closing item. An error a command or the filesystem
// raises (a missing file, a refused input, a failed child) exits 1. A BUG in the tool is JavaScript's own kind of
// error, a TypeError, a ReferenceError, a RangeError and the like, which no input should be able to cause: it says
// so, writes the stack to a crash log instead of the human view, and exits 70 (section 12). Any thrown Error used to
// count, which reported a missing file as an internal crash
const BUG_ERRORS = [TypeError, ReferenceError, RangeError, SyntaxError, EvalError, URIError]

// the failures a thrown error may name for itself, `error.failure`, each its own exit (section 18): a missing
// toolchain is `environment` (3), a bad invocation `usage` (2)
const FAILURE_KINDS = new Set(['usage', 'environment', 'bug', 'interrupted'])

export function failRun(error: unknown, root: string): number {
  const message = error instanceof Error ? error.message : String(error)
  const named = error instanceof Error ? (error as { failure?: string }).failure : undefined
  const failure = named && FAILURE_KINDS.has(named) ? named : undefined
  const bug = failure === 'bug' || (!failure && (error as { expected?: boolean })?.expected !== true && BUG_ERRORS.some(kind => error instanceof kind))

  if (!bug || !(error instanceof Error)) {
    // a tool's own output rides on the error (`runTool`), quoted under the item: the library keeps its last lines
    const quote = (error as { quote?: string[] })?.quote ?? []
    // written as thrown: a thrown message often opens with a name (`shelf has no scope`), and a capital would change it
    report({ glyph: 'failed', kind: 'problem', subject: message, quote })

    return closeRun({ verdict: 'Failed', failure })
  }

  const log = writeCrashLog(error, root)
  const crash = makeCrash(verb || 'term', `Term stopped on an internal error: ${message}`, '', log ? showPath(log, root) : '', Date.now(), STANDARD)
  crash.fields.push(field(STANDARD.fields.nextKey, 'this is a bug in Term and your code may be fine; term report files it'))
  report(crash)

  return closeRun({ verdict: 'Stopped by an internal error', failure: 'bug' })
}

function writeCrashLog(error: Error, root: string): string {
  try {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const where = path.join(root, '.term', `crash-${stamp}.log`)
    mkdirSync(path.dirname(where), { recursive: true })
    writeFileSync(where, `${error.stack ?? error.message}\n`)

    return where
  } catch {
    return ''
  }
}
