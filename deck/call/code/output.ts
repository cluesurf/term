// The CLI's side of the terminal output library (code/work/item/, note/project/term/output/readme.md): the one run a command
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
import {
  beginRun,
  endRun,
  printData as printDataOut,
  report as reportOut,
} from '@term/call/code/work/item/emit'
// the port's module whole, for a task read at CALL time: task/port-build.ts loads this file while it is building that
// port, so a name new to emit.tree cannot be a static import here, or the build that would make it refuses to start
import * as emitPort from '@term/call/code/work/item/emit'
import { adaptLine } from '@term/call/code/work/item/adapt'
import type { Runner } from '@term/call/code/work/item/emit'
import {
  arrangeProblems,
  makeOpening,
  makeOptions,
  makeCrash,
} from '@term/call/code/work/item/run'
import type { RunOptions } from '@term/call/code/work/item/run'
import {
  blankEvent,
  plainField,
  plainSubject,
} from '@term/call/code/work/item/event'
import type {
  Event,
  Frame,
  ItemField,
  Tally,
} from '@term/call/code/work/item/event'
import { makeStandard } from '@term/call/code/work/item/standard'
import { formatPath } from '@term/call/code/work/item/format'
import {
  isProgressDue,
  isRunning,
  makeProgressItem,
  placeItem,
  planFrame,
  writeFrame,
} from '@term/call/code/work/item/live'
import type { Region } from '@term/call/code/work/item/live'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as plan from '@term/call/code/output-plan'

// A DIAGNOSTIC AS A PROBLEM ITEM, its code frame, which of a batch are one problem and what a failed tool says are Term
// since 2026-10-06, call/code/output-plan.tree. This face holds the run open, reads the flags, prints through the
// output library, follows child processes and writes the crash log.

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
export function setOutput(
  flags: OutputFlags & { _?: (string | number)[] },
  toolVersion: string,
): void {
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
    color:
      flags.color === 'always' || flags.color === 'never'
        ? flags.color
        : 'auto',
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
  // a diagnostic's stable name, at the end of the title in the source color
  code?: string
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
  const one: Event = {
    ...blankEvent(),
    glyph: input.glyph ?? 'info',
    clock: input.clock ?? Date.now(),
  }

  if (input.kind !== undefined) {
    one.kind = input.kind
  }

  if (input.verb !== undefined) {
    one.verb = input.verb
  }

  if (input.subject !== undefined) {
    one.subject = plainSubject(input.subject)
  }

  if (input.source !== undefined) {
    one.source = input.source
  }

  if (input.code !== undefined) {
    one.code = input.code
  }

  if (input.duration !== undefined) {
    one.duration = input.duration
  }

  if (input.budget !== undefined) {
    one.budget = input.budget
  }

  if (input.http !== undefined) {
    one.status = { kind: 'http', value: input.http, name: '' }
  }

  if (input.exit !== undefined) {
    one.status = { kind: 'exit', value: input.exit, name: '' }
  }

  if (input.bytes !== undefined) {
    one.bytes = input.bytes
  }

  if (input.counts !== undefined) {
    one.tallies = input.counts
  }

  if (input.facts !== undefined) {
    one.facts = input.facts
  }

  if (input.message !== undefined) {
    one.message = input.message
  }

  if (input.fields !== undefined) {
    one.fields = input.fields
  }

  if (input.frames !== undefined) {
    one.frames = input.frames
  }

  if (input.quote !== undefined) {
    one.quote = input.quote
  }

  if (input.done !== undefined) {
    one.done = input.done
  }

  if (input.total !== undefined) {
    one.total = input.total
  }

  if (input.level !== undefined) {
    one.level = input.level
  }

  if (input.place !== undefined) {
    one.place = input.place
  }

  return one
}

// a count: number then noun (`42 files`), or part of a total (`31/46 files`). `one` is the singular beside 1
export function count(
  amount: number,
  noun: string,
  one = '',
  total = -1,
): Tally {
  return { amount, noun, one, total }
}

// a field of section 7
export function field(key: string, value: string): ItemField {
  return plainField(key, value)
}

// a location field, `at`, which breaks only after `/` and links to its file
export function location(where: string): ItemField {
  return {
    ...plainField(STANDARD.fields.locationKey, where),
    location: true,
  }
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
export function openRun(input: {
  verb: string
  root: string
  subject?: string
  counts?: Tally[]
  facts?: string[]
  tool?: string
  started?: number
}): void {
  verb = input.verb
  started = input.started ?? Date.now()

  // section 15: a run started by a command of another Term run is drawn under that run's elbow. The depth comes in through
  // the environment, and every child this run starts while it is open is one level deeper
  const depth = Math.max(
    0,
    Number(process.env[DEPTH_VARIABLE] ?? 0) || 0,
  )

  outerDepth = process.env[DEPTH_VARIABLE]
  options = { ...options, depth }
  process.env[DEPTH_VARIABLE] = String(depth + 1)

  const opening = makeOpening(
    input.verb,
    input.subject ?? showPath(input.root),
    started,
    input.tool ?? (version ? `term ${version}` : 'term'),
  )

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

  const made = 'tallies' in input ? input : makeItem(input)

  const event = made.verb === '' ? { ...made, verb } : made

  steps.delete(stepKey(event))

  if (live.items.length > 0) {
    reportLive(event)

    return
  }

  runner = reportOut(runner!, event)
}

// ---- progress (section 10) ----

// A RUNNING STEP is an item with the ◐ glyph, placed by `progress` and finished by the `report` of an item with the
// same verb, subject and source. ON A TERMINAL the running items are the live region at the bottom of the output,
// drawn by work/item/live.tree: `place-item` puts an item in its place, `plan-frame` decides the frame (at most one
// redraw per `redraw-ms`), `write-frame` makes its bytes. A finished item at the top of the region leaves it through
// the run's own `report`, so the session counts it and the final output is what it would be with no region at all.
// WITHOUT ONE (a pipe, `--plain`) nothing redraws: a step longer than `quiet-progress-ms` reports a `●` progress item
// once per interval (`is-progress-due`, `make-progress-item`). `--log json` and `--quiet` carry no progress at all: a
// JSON line is one finished event, never a redraw
let live: Region = { items: [], height: 0, drawnAt: -1, turn: 0 }
let ticker: ReturnType<typeof setInterval> | undefined

// when each step began and when its progress item was last reported, for the view without a terminal
const steps = new Map<string, { started: number; reported: number }>()

function stepKey(event: Event): string {
  return `${event.verb}\u0000${event.subject.map(span => span.value).join('')}\u0000${event.source}`
}

// how progress shows under the flags: a redrawn region, an item every interval, or not at all
function progressView(): 'live' | 'interval' | 'none' {
  if (!runner || options.json || options.quiet) {
    return 'none'
  }

  if (
    options.plain ||
    options.depth > 0 ||
    process.stderr.isTTY !== true
  ) {
    return 'interval'
  }

  return 'live'
}

// a step under way: `done` of `total` (a total below 0 is unknown, and draws no bar), counted in `noun`
export function progress(input: {
  verb: string
  subject: string
  done?: number
  total?: number
  noun?: string
  one?: string
  source?: string
}): void {
  if (!runner) {
    openRun({ verb: verb || 'term', root: process.cwd() })
  }

  const now = Date.now()
  const done = input.done ?? -1
  const total = input.total ?? -1
  const step = makeItem({
    glyph: 'running',
    kind: 'progress',
    verb: input.verb,
    subject: input.subject,
    source: input.source,
    clock: now,
    counts:
      input.noun !== undefined && done >= 0
        ? [count(done, input.noun, input.one ?? '', total)]
        : [],
    done,
    total,
  })

  const key = stepKey(step)
  const known = steps.get(key) ?? { started: now, reported: -1 }
  steps.set(key, known)
  // the clock and the time so far are the step's, from when it began
  step.clock = known.started
  step.duration = now - known.started

  const view = progressView()

  if (view === 'live') {
    live = placeItem(live, step)
    drawLive(false)

    if (!ticker && options.motion) {
      // the spinner and the elapsed time move while the step works, between its own updates. Unref'd: a run that is
      // done never waits on it
      ticker = setInterval(
        () => drawLive(false),
        STANDARD.lives.redrawMs,
      )
      ticker.unref()
    }
  } else if (
    view === 'interval' &&
    isProgressDue(known.started, known.reported, now, STANDARD)
  ) {
    known.reported = now
    runner = reportOut(
      runner!,
      makeProgressItem(step, known.started, now),
    )
  }
}

// the region redrawn: every running item's time brought up to now, then a frame if the redraw limit allows one
function drawLive(force: boolean): void {
  if (!runner || live.items.length === 0) {
    return
  }

  const now = Date.now()
  const room = runner.output.room
  live = {
    ...live,
    items: live.items.map(each =>
      isRunning(each) ? { ...each, duration: now - each.clock } : each,
    ),
  }

  const plan = planFrame(
    live,
    [],
    now,
    force,
    options.motion,
    room,
    options.source === '',
  )

  if (plan.draw) {
    emitPort.printRawError(
      writeFrame(
        plan,
        live.height,
        runner.output.palette,
        room.standard,
      ),
    )
    live = plan.region
  }
}

// the region taken off the screen: up over its lines and cleared, so the next line printed is where it began
function eraseLive(): void {
  if (runner && live.height > 0) {
    const blank = { region: live, committed: [], lines: [], draw: true }
    emitPort.printRawError(
      writeFrame(
        blank,
        live.height,
        runner.output.palette,
        runner.output.room.standard,
      ),
    )
  }

  live = { ...live, height: 0, drawnAt: -1 }
}

// an item reported while the region is on screen: put in its place (finishing the running step it names), the
// finished items at the top printed for good through the run, and what is still running drawn again under them
function reportLive(event: Event): void {
  live = placeItem(live, event)
  eraseLive()

  while (live.items.length > 0 && !isRunning(live.items[0]!)) {
    const first = live.items[0]!
    live = { ...live, items: live.items.slice(1) }
    runner = reportOut(runner!, first)
  }

  if (live.items.length === 0) {
    stopTicker()

    return
  }

  drawLive(true)
}

function stopTicker(): void {
  if (ticker) {
    clearInterval(ticker)
    ticker = undefined
  }
}

// the region settled before the run closes: finished items printed in their order, a step still running dropped (the
// closing item says how the run ended)
function settleLive(): void {
  stopTicker()
  steps.clear()

  if (live.items.length === 0) {
    return
  }

  eraseLive()

  const items = live.items
  live = { items: [], height: 0, drawnAt: -1, turn: 0 }

  for (const one of items) {
    if (!isRunning(one)) {
      runner = reportOut(runner!, one)
    }
  }
}

// the closing item: the verdict, the total time and the counts, a `next` field when there is one. The glyph is the
// worst of the run, and the exit code follows it (section 18). `failure` is <usage>, <environment>, <bug> or
// <interrupted> when the run ends for that reason. Sets process.exitCode, and returns it
// (`done`: the run did its work through change items, `+ − ~`, which rank below ✓ in section 4's order, so a wash
// that removed three folders would close `·`, the glyph of a run that did nothing. With it, the closing is ✓ unless
// something worse happened. A plan that only says what it WOULD change leaves it off and closes `·`)
export function closeRun(input: {
  verdict: string
  counts?: Tally[]
  facts?: string[]
  message?: string[]
  next?: string
  failure?: string
  uptime?: boolean
  done?: boolean
}): number {
  if (!runner) {
    openRun({ verb: verb || 'term', root: process.cwd() })
  }

  settleLive()

  const now = Date.now()
  // under --strict a run whose worst item is a warning closes ✗ and exits 1 (section 18), whatever its verdict says
  // ("1 file built"): the closing says why, so the glyph and the verdict do not seem to disagree
  const strictly =
    options.strict &&
    !input.failure &&
    runner?.session.worstGlyph === 'warning'
      ? ['Warnings fail the run under --strict.']
      : []

  const closing = makeItem({
    verb,
    subject: input.verdict,
    clock: now,
    duration: now - started,
    counts: input.counts,
    facts: input.facts,
    message: [...(input.message ?? []), ...strictly],
  })

  closing.uptime = input.uptime ?? false

  if (input.next) {
    closing.fields = [field(STANDARD.fields.nextKey, input.next)]
  }

  let one = runner!

  const doneRank =
    STANDARD.glyphs.find(glyph => glyph.name === 'done')?.rank ?? 0

  if (input.done && one.session.worst < doneRank) {
    one = {
      ...one,
      session: { ...one.session, worst: doneRank, worstGlyph: 'done' },
    }
  }

  if (input.failure) {
    one = {
      ...one,
      session: { ...one.session, failure: input.failure },
    }
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
  if (
    runner?.session.owed &&
    process.stdout.isTTY &&
    process.stderr.isTTY
  ) {
    // a standard that spaces its runs (v2); v3 draws no blank lines, and the data follows the opening directly
    if (STANDARD.layout.spacing) {
      process.stderr.write('\n')
    }

    runner = { ...runner, session: { ...runner.session, owed: false } }
  }

  // section 15: after an item, on the terminal the run is on, data hangs under that item's elbow so the run keeps its left
  // edge (`term self load` prints the `export PATH=...` line it names). A pipe, `--log json` and `--plain` get it as it is
  if (
    runner &&
    runner.session.printed > 0 &&
    process.stdout.isTTY &&
    process.stderr.isTTY &&
    !options.json &&
    !options.plain
  ) {
    emitPort.printDataUnder(runner, value)

    return
  }

  printDataOut(value)
}

// bytes the user asked for (`term mold --code`), on stdout exactly as they are: binary, so no elbow and no layout
export function printBytes(bytes: Uint8Array): void {
  process.stdout.write(bytes)
}

// a timing line a person switched on for one command (`TERM_ROLL_PROFILE=1`), on stderr as it is, so it never mixes
// with the data on stdout
export function printProfile(line: string): void {
  emitPort.printRawError(`${line}\n`)
}

// ---- a child process ----

// a toolchain step run for its result (a compiler, a linker, a signer, a device bridge): its output is the TOOL's,
// so it is never mixed into the run's own lines (section 15). On success it is kept out of the way and the stdout is
// handed back. On failure the step throws an error that names the tool and its exit, carrying the output as `quote`,
// which `failRun` draws under the ✗ item. A tool that is not installed is `environment`, exit 3. Under `--raw` the
// tool writes to the terminal as it runs, as it always did
export function runTool(
  cmd: string,
  args: string[],
  spawnOptions: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  if (options.raw) {
    execFileSync(cmd, args, { ...spawnOptions, stdio: 'inherit' })

    return ''
  }

  try {
    return execFileSync(cmd, args, {
      ...spawnOptions,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
    })
  } catch (error) {
    const failed = error as {
      status?: number | null
      signal?: string | null
      stdout?: string
      stderr?: string
      code?: string
    }

    const missing = failed.code === 'ENOENT'
    const said = plan.toolFailureOf(
      path.basename(cmd),
      missing,
      failed.signal || '',
      failed.status ?? 1,
      `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    )

    throw Object.assign(new Error(said.message), {
      expected: true,
      quote: said.quote,
      failure: missing ? 'environment' : undefined,
    })
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
    report({
      glyph: 'info',
      verb: STANDARD.children.defaultVerb,
      subject: source,
      quote,
    })
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
    const adapted = adaptLine(
      line,
      Date.now(),
      room.offset,
      false,
      room,
    )

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

  const follow = (
    stream: Readable | null,
    fromError: boolean,
  ): void => {
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
function placeOf(
  file: string,
  span: Diagnostic['span'],
  root: string,
): string {
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
function frameOf(
  diagnostic: Diagnostic,
  lines: string[],
): Frame | undefined {
  const made = plan.frameOf(
    diagnostic as plan.Diagnostic,
    lines,
    STANDARD.frames.tabWidth,
  )

  return made.form === 'some' ? (made.value as Frame) : undefined
}

// a diagnostic as a Problem item (section 12): the message is the subject, the location an `at` field, the source a
// code frame, the hint a `next` field. A proof obligation's verb is `prove`, everything else `check`
export function problemOf(
  diagnostic: Diagnostic,
  root: string,
  text?: string,
): Event {
  const fields: ItemField[] = [
    location(placeOf(diagnostic.file, diagnostic.span, root)),
  ]

  if (diagnostic.hint) {
    fields.push(field(STANDARD.fields.nextKey, diagnostic.hint))
  }

  const frame = frameOf(diagnostic, sourceLines(diagnostic.file, text))
  // the glyph, the verb, the subject a sentence (capital first unless it opens with a path or a name), the message's
  // other lines, and the name with a lint rule's code: output-plan.tree `problem-words-of`
  const words = plan.problemWordsOf(diagnostic as plan.Diagnostic)

  return makeItem({
    glyph: words.glyph,
    kind: 'problem',
    verb: words.verb,
    subject: words.subject,
    message: words.message,
    code: words.code,
    fields,
    frames: frame ? [frame] : [],
    place: {
      path: showPath(diagnostic.file, root),
      line: diagnostic.span.start.line + 1,
      column: diagnostic.span.start.column + 1,
    },
  })
}

export function reportProblem(
  diagnostic: Diagnostic,
  root: string,
  text?: string,
): void {
  report(problemOf(diagnostic, root, text))
}

// a batch of diagnostics as section 12 prints them: sorted by path, line and column, one caused by an earlier one
// hidden, and past the standard's cap one `… n more problems` item. A line with no diagnostic behind it (`faults`)
// is a problem item of its own, after them
export function reportProblems(
  list: { diagnostic: Diagnostic; text?: string }[],
  root: string,
  faults: string[] = [],
): void {
  if (!runner) {
    openRun({ verb: verb || 'term', root })
  }

  // ONE item per problem: a diagnostic in a module several entries load comes back once per entry, and the build
  // printed a stdlib module's two errors four times each. The same file, place, name and message is the same problem
  const kept = plan.uniqueProblems(
    list.map(each => each.diagnostic as plan.Diagnostic),
  )

  const unique = list.filter((_, at) => kept[at])

  const standard = showAll
    ? { ...STANDARD, caps: { ...STANDARD.caps, problems: 0 } }
    : STANDARD

  for (const one of arrangeProblems(
    unique.map(each => problemOf(each.diagnostic, root, each.text)),
    standard,
    runner!.output.room,
  )) {
    report(one)
  }

  for (const fault of faults) {
    report({
      glyph: 'failed',
      kind: 'problem',
      verb: 'check',
      subject: fault,
    })
  }
}

// ---- a failure nobody caught ----

// a thrown error ends the run: its message as a ✗ item and the closing item. An error a command or the filesystem
// raises (a missing file, a refused input, a failed child) exits 1. A BUG in the tool is JavaScript's own kind of
// error, a TypeError, a ReferenceError, a RangeError and the like, which no input should be able to cause: it says
// so, writes the stack to a crash log instead of the human view, and exits 70 (section 12). Any thrown Error used to
// count, which reported a missing file as an internal crash
const BUG_ERRORS = [
  TypeError,
  ReferenceError,
  RangeError,
  SyntaxError,
  EvalError,
  URIError,
]

// the failures a thrown error may name for itself, `error.failure`, each its own exit (section 18): a missing
// toolchain is `environment` (3), a bad invocation `usage` (2)
const FAILURE_KINDS = new Set([
  'usage',
  'environment',
  'bug',
  'interrupted',
])

export function failRun(error: unknown, root: string): number {
  if (runner) {
    settleLive()
  }

  const message = error instanceof Error ? error.message : String(error)
  const named =
    error instanceof Error
      ? (error as { failure?: string }).failure
      : undefined

  const failure = named && FAILURE_KINDS.has(named) ? named : undefined
  const bug =
    failure === 'bug' ||
    (!failure &&
      (error as { expected?: boolean })?.expected !== true &&
      BUG_ERRORS.some(kind => error instanceof kind))

  if (!bug || !(error instanceof Error)) {
    // a tool's own output rides on the error (`runTool`), quoted under the item: the library keeps its last lines
    const quote = (error as { quote?: string[] })?.quote ?? []
    // written as thrown: a thrown message often opens with a name (`shelf has no scope`), and a capital would change it
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: message,
      quote,
    })

    return closeRun({ verdict: 'Failed', failure })
  }

  const log = writeCrashLog(error, root)
  const crash = makeCrash(
    verb || 'term',
    `Term stopped on an internal error: ${message}`,
    '',
    log ? showPath(log, root) : '',
    Date.now(),
    STANDARD,
  )

  crash.fields.push(
    field(
      STANDARD.fields.nextKey,
      'this is a bug in Term and your code may be fine; term report files it',
    ),
  )
  report(crash)

  return closeRun({
    verdict: 'Stopped by an internal error',
    failure: 'bug',
  })
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
