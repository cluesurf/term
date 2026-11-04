// The resumable sweep: re-runs every pair in task/term/pair-list.txt, each as a child process under a timeout, and
// prints one verdict (note/workflow/build/term-self-host/verification.md#the-sweep).
//
//   sh tmp/run-term.sh npx tsx task/term/pair-sweep.ts [--from <name>] [--resume] [--timeout min] [--list]
//     [--jobs n] [--only a,b]
//
// --jobs runs n lines at once (default 1), each bounded by NODE_OPTIONS as the caller sets it. --only runs the named
// lines alone. A resume runs every line the cursor does not hold.
//
// A list line is `pair <name> [args]` (the generic runner, task/term/pair.ts) or `legacy <tmp/pair-x.ts> [args]` (a
// bespoke pair, run from the Term package). A trailing `# baseline N` marks a known, explained disagreement count.
//
// VERDICTS per line
//   PASS      disagree is 0, or equal to the line's baseline (a count that FELL below its baseline is reported)
//   FAIL      disagree rose above the baseline (a known disagreement that rises fails even when nonzero was its
//             baseline), or the generic runner printed `status: FAIL`
//   TIMEOUT   the child ran past the timeout, and its whole process group was killed
//   UNPARSED  a legacy pair's last line has none of the known shapes (`N agree, M disagree`, `M disagree`, `N
//             differ`), so the sweep refuses to guess; the line is in the verdict and in the log
//
// The sweep never stops on one failure. After each line it writes `{ index, name, verdict, results }` to
// <term>/tmp/self-host/sweep-cursor.json (`results` holds every line recorded so far), and `--resume` starts after
// the last recorded line. A child's full output goes to <term>/tmp/self-host/sweep/<name>.log.
//
// TIMEOUTS. Each child is spawned detached, so it leads its own process group, and a timeout (or this process being
// interrupted) kills the group, which takes tsx's child node process with it. A kill of the top process alone left
// the old perl alarm hanging on pair-census.
//
// Exit 0 when nothing failed, timed out or went unparsed, 1 otherwise, 2 on a usage error.

import { spawn } from 'node:child_process'
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const USAGE = 'usage: pair-sweep.ts [--from <name>] [--resume] [--timeout min] [--list] [--jobs n] [--only a,b]'
const DEFAULT_MINUTES = 20
const SETTLE_MS = 2000

type Entry = {
  index: number
  name: string
  kind: 'pair' | 'legacy'
  target: string
  args: string[]
  baseline: number | null
  text: string
}

type Verdict = 'PASS' | 'FAIL' | 'TIMEOUT' | 'UNPARSED'

type Result = {
  index: number
  name: string
  verdict: Verdict
  disagree: number | null
  baseline: number | null
  moved: boolean
  last: string
  seconds: number
}

type Cursor = { index: number; name: string; verdict: Verdict; total: number; results: Result[] }

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

const repo = TERM_ROOT
const term = process.cwd()
const listFile = join(repo, 'task/term/pair-list.txt')
const tsx = join(repo, 'node_modules/tsx/dist/cli.mjs')
const cursorFile = join(term, 'tmp/self-host/sweep-cursor.json')
const logDir = join(term, 'tmp/self-host/sweep')

type Options = { from: string | null; resume: boolean; minutes: number; list: boolean; jobs: number; only: string[] | null }

function parseArguments(args: string[]): Options {
  const options: Options = { from: null, resume: false, minutes: DEFAULT_MINUTES, list: false, jobs: 1, only: null }

  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    const equals = arg.indexOf('=')
    const flag = arg.startsWith('--') && equals > 0 ? arg.slice(0, equals) : arg
    const inline = arg.startsWith('--') && equals > 0 ? arg.slice(equals + 1) : undefined
    const value = (): string | undefined => inline ?? args[++at]

    if (flag === '--resume') options.resume = true
    else if (flag === '--list') options.list = true
    else if (flag === '--from') {
      const text = value()

      if (!text) usage('--from wants a pair name')

      options.from = text
    } else if (flag === '--timeout') {
      const text = value()
      const minutes = text === undefined ? NaN : Number(text)

      if (!Number.isFinite(minutes) || minutes <= 0) usage(`--timeout wants minutes above 0, got ${text ?? 'nothing'}`)

      options.minutes = minutes
    } else if (flag === '--jobs') {
      const text = value()
      const jobs = text === undefined ? NaN : Number(text)

      if (!Number.isInteger(jobs) || jobs < 1) usage(`--jobs wants a whole number above 0, got ${text ?? 'nothing'}`)

      options.jobs = jobs
    } else if (flag === '--only') {
      const text = value()

      if (!text) usage('--only wants pair names, comma separated')

      options.only = text.split(',')
    } else usage(`unknown argument ${arg}`)
  }

  if (options.resume && options.from !== null) usage('--resume and --from cannot be combined')

  return options
}

// ---- the list ----

function nameOf(kind: Entry['kind'], target: string): string {
  if (kind === 'pair') return target

  const base = target.slice(target.lastIndexOf('/') + 1).replace(/\.ts$/, '')

  return base.replace(/^pair-/, '')
}

function readList(): Entry[] {
  const entries: Entry[] = []
  const seen = new Set<string>()
  const lines = readFileSync(listFile, 'utf8').split('\n')

  lines.forEach((raw, at) => {
    const hash = raw.indexOf('#')
    const code = (hash >= 0 ? raw.slice(0, hash) : raw).trim()

    if (code === '') return

    const comment = hash >= 0 ? raw.slice(hash + 1) : ''
    const parts = code.split(/\s+/)
    const kind = parts[0]

    if ((kind !== 'pair' && kind !== 'legacy') || parts.length < 2) {
      usage(`${listFile}:${at + 1}: a line is \`pair <name>\` or \`legacy <tmp/pair-x.ts> [args]\`, got "${code}"`)
    }

    const target = parts[1]!
    const name = nameOf(kind, target)

    if (seen.has(name)) usage(`${listFile}:${at + 1}: "${name}" is listed twice`)

    seen.add(name)

    const found = /\bbaseline\s+(\d[\d,]*)/.exec(comment)

    entries.push({
      index: entries.length,
      name,
      kind,
      target,
      args: parts.slice(2),
      baseline: found ? Number(found[1]!.replace(/,/g, '')) : null,
      text: code,
    })
  })

  return entries
}

// ---- running one line ----

function commandFor(entry: Entry): string[] {
  if (entry.kind === 'pair') return [tsx, join(repo, 'task/term/pair.ts'), entry.target, ...entry.args]

  return [tsx, entry.target, ...entry.args]
}

const children = new Set<number>()

function killGroup(pid: number): void {
  try {
    process.kill(-pid, 'SIGKILL')
  } catch {
    // already gone
  }
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    for (const pid of children) killGroup(pid)

    process.exit(130)
  })
}

// runs the child, its output into `log`; resolves true when the timeout killed it
function runChild(entry: Entry, log: string, limitMs: number): Promise<boolean> {
  return new Promise(done => {
    const fd = openSync(log, 'w')
    const child = spawn(process.execPath, commandFor(entry), {
      cwd: term,
      detached: true,
      stdio: ['ignore', fd, fd],
    })
    const pid = child.pid!
    let timedOut = false
    let settled = false

    children.add(pid)

    const finish = (): void => {
      if (settled) return

      settled = true
      clearTimeout(timer)
      children.delete(pid)
      // anything the child left behind in its group goes with it
      killGroup(pid)
      closeSync(fd)
      done(timedOut)
    }

    const timer = setTimeout(() => {
      timedOut = true
      killGroup(pid)
      // the exit event follows the kill; if it does not, settle anyway
      setTimeout(finish, SETTLE_MS)
    }, limitMs)

    child.on('exit', finish)
    child.on('error', finish)
  })
}

function lastLine(text: string): string {
  const lines = text
    .split('\n')
    .map(line => line.trimEnd())
    .filter(line => line.trim() !== '' && !line.includes('Unknown user config'))

  return lines.length === 0 ? '' : lines[lines.length - 1]!
}

function number(text: string): number {
  return Number(text.replace(/,/g, ''))
}

// the generic runner's verdict: `status:` and the `disagree:` row
function judgeRunner(text: string, baseline: number | null): Pick<Result, 'verdict' | 'disagree' | 'moved'> {
  const status = /^status:\s*(PASS|FAIL)\s*$/m.exec(text)
  const row = /^disagree:\s+([\d,]+)\s*$/m.exec(text)
  const disagree = row ? number(row[1]!) : null

  if (!status) return { verdict: 'UNPARSED', disagree, moved: false }
  if (status[1] === 'PASS') return { verdict: 'PASS', disagree, moved: false }

  // a failed runner pair is a FAIL unless its only reason is a disagree count held at its baseline
  if (baseline !== null && disagree !== null && disagree <= baseline && /^reason:\s*disagree [\d,]+\s*$/m.test(text)) {
    return { verdict: 'PASS', disagree, moved: disagree !== baseline }
  }

  return { verdict: 'FAIL', disagree, moved: false }
}

// a bespoke pair's total, `N agree, M disagree`, `M disagree` or `N differ`, on the LAST line of its log that holds
// one: a pair may print its census (distinct inputs and hard-case counts) after the total. A census that says FAILED
// (a hard case never met, so the agreement proves less than it claims) fails the pair whatever its total
function judgeLegacy(text: string, baseline: number | null): Pick<Result, 'verdict' | 'disagree' | 'moved'> {
  const totals = text.split('\n').filter(line => /\d[\d,]*\s+(disagree|differ)\b/.test(line))
  const line = totals.at(-1) ?? ''
  const disagree = /(\d[\d,]*)\s+disagree\b/.exec(line)
  const differ = /(\d[\d,]*)\s+differ\b/.exec(line)
  const found = disagree ?? differ

  if (!found) return { verdict: 'UNPARSED', disagree: null, moved: false }

  const count = number(found[1]!)
  const held = baseline ?? 0

  if (/census FAILED/.test(text)) return { verdict: 'FAIL', disagree: count, moved: false }
  if (count > held) return { verdict: 'FAIL', disagree: count, moved: false }

  return { verdict: 'PASS', disagree: count, moved: baseline !== null && count !== baseline }
}

async function runEntry(entry: Entry, minutes: number): Promise<Result> {
  const log = join(logDir, `${entry.name}.log`)
  const started = Date.now()
  const timedOut = await runChild(entry, log, minutes * 60_000)
  const seconds = Math.round((Date.now() - started) / 1000)
  const text = existsSync(log) ? readFileSync(log, 'utf8') : ''
  const last = lastLine(text)

  if (timedOut) {
    return { index: entry.index, name: entry.name, verdict: 'TIMEOUT', disagree: null, baseline: entry.baseline, moved: false, last, seconds }
  }

  const judged = entry.kind === 'pair' ? judgeRunner(text, entry.baseline) : judgeLegacy(text, entry.baseline)

  return { index: entry.index, name: entry.name, baseline: entry.baseline, last, seconds, ...judged }
}

// ---- the cursor and the verdict ----

function readCursor(): Cursor | null {
  if (!existsSync(cursorFile)) return null

  try {
    return JSON.parse(readFileSync(cursorFile, 'utf8')) as Cursor
  } catch {
    return null
  }
}

function writeCursor(total: number, results: Result[]): void {
  const last = results[results.length - 1]!
  const cursor: Cursor = { index: last.index, name: last.name, verdict: last.verdict, total, results }

  writeFileSync(cursorFile, `${JSON.stringify(cursor, null, 2)}\n`)
}

function named(results: Result[], show: (result: Result) => string): string {
  if (results.length === 0) return 'none'

  const text = results.map(show).join(', ')

  return text.length > 220 ? `${text.slice(0, 220)}... (+more in sweep-cursor.json)` : text
}

function verdictText(results: Result[], total: number, first: number, resumedAt: number | null): string {
  const by = (verdict: Verdict): Result[] => results.filter(result => result.verdict === verdict)
  const pass = by('PASS')
  const fail = by('FAIL')
  const timeout = by('TIMEOUT')
  const unparsed = by('UNPARSED')
  const moved = results.filter(result => result.baseline !== null)
  const shifted = moved.filter(result => result.moved || result.verdict === 'FAIL')
  const bad = fail.length + timeout.length + unparsed.length

  const out = [
    `SWEEP ${results.length} lines run of ${total} (from line ${first}${resumedAt === null ? '' : `, resumed at line ${resumedAt}`})`,
    `PASS: ${pass.length}`,
    `FAIL: ${fail.length}  ${named(fail, result => `${result.name} (${result.disagree ?? 'no count'} disagree${result.baseline === null ? '' : `, baseline ${result.baseline}`})`)}`,
    `TIMEOUT: ${timeout.length}  ${named(timeout, result => `${result.name} (${result.seconds}s)`)}`,
    `UNPARSED: ${unparsed.length}  ${named(unparsed, result => `${result.name} ("${result.last.slice(0, 60)}")`)}`,
    `known disagreements: ${moved.length} listed, ${shifted.length === 0 ? 'none moved from baseline' : `${shifted.length} MOVED`}`,
  ]

  for (const result of shifted.slice(0, 3)) {
    out.push(`  ${result.name}: ${result.disagree ?? 'no count'} against baseline ${result.baseline} (${result.verdict})`)
  }

  out.push(`logs: ${logDir}/<name>.log, cursor: ${cursorFile}`)
  out.push(`status: ${bad === 0 ? 'PASS' : 'FAIL'}`)

  return `${out.join('\n')}\n`
}

// ---- main ----

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const entries = readList()

  if (options.list) {
    let missing = 0

    for (const entry of entries) {
      const file = entry.kind === 'legacy' ? join(term, entry.target) : join(term, 'tmp/self-host/pairs', `${entry.target}.ts`)
      const here = existsSync(file)

      if (!here) missing++

      console.log(`${String(entry.index).padStart(3)} ${entry.name}${entry.baseline === null ? '' : ` baseline ${entry.baseline}`}${here ? '' : '  MISSING ' + file}`)
    }

    console.log(`${entries.length} lines, ${missing} missing`)
    process.exit(missing === 0 ? 0 : 1)
  }

  if (entries.length === 0) usage(`${listFile} has no lines`)

  mkdirSync(logDir, { recursive: true })

  let results: Result[] = []
  let first = 0
  let resumedAt: number | null = null

  if (options.resume) {
    const cursor = readCursor()

    if (!cursor) usage(`no cursor at ${cursorFile} to resume from`)

    const last = cursor.results[cursor.results.length - 1]

    if (!last || entries[last.index]?.name !== last.name) {
      usage('the cursor does not match task/term/pair-list.txt any more; run without --resume')
    }

    results = cursor.results
    first = results[0]!.index
    resumedAt = results.length === entries.length ? entries.length : entries.findIndex(entry => !results.some(result => result.index === entry.index))
  } else if (options.from !== null) {
    const at = entries.findIndex(entry => entry.name === options.from)

    if (at < 0) usage(`no pair named "${options.from}" in ${listFile}`)

    first = at
  }

  const start = resumedAt ?? first

  if (start >= entries.length) {
    process.stdout.write(`nothing to resume: every line is recorded\n${verdictText(results, entries.length, first, resumedAt)}`)
    process.exit(results.some(result => result.verdict !== 'PASS') ? 1 : 0)
  }

  const recorded = new Set(results.map(result => result.index))
  const only = options.only === null ? null : new Set(options.only)
  const waiting = (options.resume ? entries : entries.slice(start)).filter(
    entry => !recorded.has(entry.index) && (only === null || only.has(entry.name)),
  )
  const worker = async (): Promise<void> => {
    for (let entry = waiting.shift(); entry; entry = waiting.shift()) {
      console.error(`[${entry.index + 1}/${entries.length}] ${entry.text}`)

      const result = await runEntry(entry, options.minutes)

      results.push(result)
      // the cursor stays in list order, whichever line ended first, so --resume can read it
      results.sort((a, b) => a.index - b.index)
      writeCursor(entries.length, results)
      console.error(`  ${entry.name}: ${result.verdict} ${result.disagree === null ? '' : `${result.disagree} disagree `}(${result.seconds}s)`)
    }
  }

  await Promise.all(Array.from({ length: options.jobs }, worker))

  process.stdout.write(verdictText(results, entries.length, first, resumedAt))
  process.exitCode = results.some(result => result.verdict !== 'PASS') ? 1 : 0
}

main().catch((cause: unknown) => {
  console.error(cause)
  process.exitCode = 2
})
