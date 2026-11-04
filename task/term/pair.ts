// The generic pair runner: one command holds any port against its original over the same inputs and prints the
// same verdict for every pair (note/workflow/build/term-self-host/verification.md#the-harness).
//
//   sh tmp/run-term.sh npx tsx task/term/pair.ts <name> [--sample N] [--seed S] [--timeout ms] [--keep]
//
// `<name>` is a module at tmp/self-host/pairs/<name>.ts exporting `pair: PairSpec`. For each
// input the runner runs `original` and `port`, each under the timeout, and files the case as:
//
//   equal       both answered, and the answers are the same under `compare`
//   both-threw  both threw the same class with the same message (never counted as equal: traps.md T028), or both
//               answered a text holding ReferenceError or "is not a function" (a caught throw, decision 018 part 5)
//   disagree    a different answer, one threw, a different error, or a timeout on either side
//
// `status: PASS` needs `disagree: 0` and every declared hard case counted above zero (traps.md T027). A
// disagreement is reported by signature: the first differing JSON path plus each side's outcome. Each signature
// keeps its smallest input (by `show`), shrunk with `shrink` while the signature holds (200 tries), and writes
// `fail-<letter>.json` (that input) and `fail-<letter>.diff` (both outputs, unified diff of the sorted JSON)
// under tmp/self-host/<name>/, with `disagree.jsonl` holding every disagreement.
//
// Exit 0 on PASS, 1 on FAIL, 2 on a usage error. Run from the Term root, the way every other term task is.
//
// TIMEOUTS. An asynchronous side is cut at the timeout. A synchronous side cannot be interrupted, so one that
// returns late is counted as a timeout when it returns, and one that never returns is caught by a watchdog thread
// that names the case and kills the process (exit 137) a few seconds past the timeout.
//
// TEMPORARY FOLDERS. The run owns one scratch folder, <system temp>/tp<pid>-XXXXXX (task/term/temp-run.ts), and points
// TMPDIR at it before the spec loads, so every folder a spec or a side makes with os.tmpdir() (and every child process
// it spawns) lands under it. It is removed when the run ends: a pass, a fail, a throw, ctrl-c, SIGTERM, and the
// watchdog's kill. `--keep` keeps it and prints its path, for debugging only. A spec never removes its own case
// folders: the run does. Before 2026-10-23 every case folder stayed, and they filled the disk (term-cli-in-term-0177).

import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Worker } from 'node:worker_threads'
import { bytesOf, canon, firstDiff, unifiedDiff } from './pair/canon'
import { makeScratch, removeOwnRuns, removeTree, scratchEnv, sweepStaleRuns } from './temp-run'

export type PairSpec<I, O> = {
  name: string
  original: (input: I) => O | Promise<O>
  port: (input: I) => O | Promise<O>
  inputs: () => Iterable<I> | AsyncIterable<I>
  compare?: 'json-sorted' | 'bytes' | ((a: O, b: O) => boolean)
  hard?: Record<string, (input: I) => boolean>
  show?: (input: I) => string
  shrink?: (input: I) => Iterable<I>
}

type Outcome =
  | { kind: 'value'; value: unknown }
  | { kind: 'threw'; cls: string; message: string }
  | { kind: 'timeout' }

type Comparison =
  | { verdict: 'equal' }
  | { verdict: 'both-threw' }
  | { verdict: 'disagree'; path: string; signature: string }

type Found = {
  input: unknown
  show: string
  original: Outcome
  port: Outcome
}

type Group = {
  signature: string
  path: string
  count: number
  best: Found
  letter: string
}

const SHRINK_TRIES = 200
const GRACE_MS = 3000
const USAGE = 'usage: pair.ts <name> [--sample N] [--seed S] [--timeout ms] [--keep]'

function usage(message: string): never {
  console.error(`${message}\n${USAGE}`)
  process.exit(2)
}

type Options = { name: string; sample: number | null; seed: number; timeout: number; keep: boolean }

function integer(flag: string, text: string | undefined, least: number): number {
  const value = text === undefined ? NaN : Number(text)

  if (!Number.isInteger(value) || value < least) {
    usage(`${flag} wants an integer of at least ${least}, got ${text === undefined ? 'nothing' : `"${text}"`}`)
  }

  return value
}

function parseArguments(args: string[]): Options {
  let name: string | null = null
  let sample: number | null = null
  let seed = 1
  let timeout = 10_000
  let keep = false

  for (let at = 0; at < args.length; at++) {
    const arg = args[at]!
    const equals = arg.indexOf('=')
    const flag = arg.startsWith('--') && equals > 0 ? arg.slice(0, equals) : arg
    const inline = arg.startsWith('--') && equals > 0 ? arg.slice(equals + 1) : undefined
    const value = (): string | undefined => inline ?? args[++at]

    if (flag === '--sample') sample = integer(flag, value(), 1)
    else if (flag === '--seed') seed = integer(flag, value(), 0)
    else if (flag === '--timeout') timeout = integer(flag, value(), 1)
    else if (flag === '--keep') keep = true
    else if (flag.startsWith('-')) usage(`unknown flag ${flag}`)
    else if (name === null) name = arg
    else usage(`unexpected argument ${arg}`)
  }

  if (name === null) usage('a pair name is required')
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) usage(`a pair name is kebab-case, got "${name}"`)

  return { name, sample, seed, timeout, keep }
}

// a small seeded generator, so `--sample N --seed S` picks the same inputs every time
function generator(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0

    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---- the watchdog ----

const WATCHDOG = `
const { workerData } = require('node:worker_threads')
const { writeSync, rmSync } = require('node:fs')
const { shared, limit, name, scratch } = workerData
const clock = new Float64Array(shared, 0, 1)
const slot = new Int32Array(shared, 8, 2)
const nap = new Int32Array(new SharedArrayBuffer(4))
for (;;) {
  Atomics.wait(nap, 0, 0, 100)
  const at = clock[0]
  if (at !== 0 && Date.now() - at > limit + ${GRACE_MS}) {
    writeSync(1, 'PAIR ' + name + '\\nstatus: FAIL\\nreason: case ' + slot[0] + ' hung in the ' +
      (slot[1] === 1 ? 'original' : 'port') + ' past ' + limit + ' ms, so the run was killed\\n')
    if (scratch) { try { rmSync(scratch, { recursive: true, force: true }) } catch {} }
    process.kill(process.pid, 'SIGKILL')
  }
}
`

type Watchdog = {
  begin: (index: number, side: 1 | 2) => void
  end: () => void
  stop: () => void
}

// `scratch` is the run's temporary folder, removed before the kill (null under --keep)
function startWatchdog(name: string, limit: number, scratch: string | null): Watchdog {
  const shared = new SharedArrayBuffer(16)
  const clock = new Float64Array(shared, 0, 1)
  const slot = new Int32Array(shared, 8, 2)
  const worker = new Worker(WATCHDOG, { eval: true, workerData: { shared, limit, name, scratch } })

  worker.unref()

  return {
    begin(index, side) {
      slot[0] = index
      slot[1] = side
      clock[0] = Date.now()
    },
    end() {
      clock[0] = 0
    },
    stop() {
      void worker.terminate()
    },
  }
}

// ---- running one case ----

function thrown(cause: unknown): Outcome {
  if (cause instanceof Error) {
    return { kind: 'threw', cls: cause.constructor?.name ?? 'Error', message: cause.message }
  }

  const named = (cause as { constructor?: { name?: string } } | null | undefined)?.constructor?.name

  return { kind: 'threw', cls: named ?? typeof cause, message: String(cause) }
}

async function runSide(
  fn: (input: never) => unknown,
  input: unknown,
  limit: number,
  watch: Watchdog,
  index: number,
  side: 1 | 2,
): Promise<Outcome> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<'late'>(resolve => {
    timer = setTimeout(() => resolve('late'), limit)
  })
  const started = Date.now()

  watch.begin(index, side)

  try {
    const answer = await Promise.race([
      Promise.resolve().then(() => fn(input as never)),
      late,
    ])

    if (answer === 'late' || Date.now() - started > limit) return { kind: 'timeout' }

    return { kind: 'value', value: answer }
  } catch (cause) {
    return Date.now() - started > limit ? { kind: 'timeout' } : thrown(cause)
  } finally {
    clearTimeout(timer)
    watch.end()
  }
}

function label(outcome: Outcome): string {
  if (outcome.kind === 'value') return 'value'
  if (outcome.kind === 'timeout') return 'timeout'

  return `threw ${outcome.cls}`
}

function brief(outcome: Outcome): string {
  const text =
    outcome.kind === 'value'
      ? canon(outcome.value)
      : outcome.kind === 'timeout'
        ? 'timeout'
        : `threw ${outcome.cls}: ${outcome.message}`

  const line = text.replace(/\s*\n\s*/g, ' ')

  return line.length > 300 ? `${line.slice(0, 300)}...` : line
}

// the lines the diff file shows for one outcome
function outputText(outcome: Outcome, compare: PairSpec<unknown, unknown>['compare']): string {
  if (outcome.kind === 'timeout') return '!timeout\n'
  if (outcome.kind === 'threw') return `!threw ${outcome.cls}: ${outcome.message}\n`

  if (compare === 'bytes') {
    return `${canon(bytesOf(outcome.value))}\n`
  }

  return `${canon(outcome.value)}\n`
}

// an answer whose text holds a ReferenceError or "is not a function" is a throw a spec caught and wrote down as data: a
// port that calls a name it never defined. Two such answers are both-threw, never equal, or a port broken the same way
// as a broken original passes as equal (decision 018 part 5, term-cli-in-term-0229)
const BROKEN_ANSWER = /ReferenceError|is not a function/

function carriesBreak(outcome: Outcome): boolean {
  if (outcome.kind !== 'value') return false

  let text: string

  try {
    text = canon(outcome.value)
  } catch {
    text = String(outcome.value)
  }

  return BROKEN_ANSWER.test(text)
}

function compareOutcomes(
  a: Outcome,
  b: Outcome,
  compare: PairSpec<unknown, unknown>['compare'],
): Comparison {
  const disagree = (path: string): Comparison => ({
    verdict: 'disagree',
    path,
    signature: `${path} | original ${label(a)} | port ${label(b)}`,
  })

  if (a.kind === 'timeout' || b.kind === 'timeout') return disagree('$')

  if (carriesBreak(a) && carriesBreak(b)) return { verdict: 'both-threw' }

  if (a.kind === 'threw' && b.kind === 'threw') {
    if (a.cls === b.cls && a.message === b.message) return { verdict: 'both-threw' }

    return disagree(a.cls === b.cls ? '$error.message' : '$error.class')
  }

  if (a.kind === 'threw' || b.kind === 'threw') return disagree('$')

  if (typeof compare === 'function') {
    try {
      return compare(a.value, b.value) ? { verdict: 'equal' } : disagree('$')
    } catch {
      return disagree('$compare-threw')
    }
  }

  if (compare === 'bytes') {
    const at = firstDiff(bytesOf(a.value), bytesOf(b.value))

    return at === null ? { verdict: 'equal' } : disagree(at)
  }

  if (canon(a.value) === canon(b.value)) return { verdict: 'equal' }

  return disagree(firstDiff(a.value, b.value) ?? '$')
}

// ---- reporting ----

function count(n: number): string {
  return n.toLocaleString('en-US')
}

function row(name: string, n: number): string {
  const number = count(n)

  return `${name}${number.padStart(Math.max(1, 19 - name.length))}`
}

function letterFor(index: number): string {
  let rest = index
  let text = ''

  do {
    text = String.fromCharCode(97 + (rest % 26)) + text
    rest = Math.floor(rest / 26) - 1
  } while (rest >= 0)

  return text
}

function inputText(input: unknown): string {
  try {
    const text = JSON.stringify(input, null, 2)

    if (text !== undefined && canon(JSON.parse(text)) === canon(input)) return `${text}\n`
  } catch {
    // not plain JSON, fall through to the canonical text
  }

  return `${canon(input)}\n`
}

async function main(): Promise<void> {
  const options = parseArguments(process.argv.slice(2))
  const term = process.cwd()
  const file = join(term, 'tmp/self-host/pairs', `${options.name}.ts`)

  if (!existsSync(file)) usage(`no pair spec at ${file} (run from the Term root)`)

  // the run's temporary folder, before the spec loads: a spec makes its folders at load time as well as per case
  sweepStaleRuns()
  scratch = makeScratch('tp')
  keep = options.keep
  Object.assign(process.env, scratchEnv(scratch))

  const loaded = (await import(pathToFileURL(file).href)) as { pair?: PairSpec<unknown, unknown> }
  const pair = loaded.pair

  if (
    !pair ||
    typeof pair.original !== 'function' ||
    typeof pair.port !== 'function' ||
    typeof pair.inputs !== 'function'
  ) {
    usage(`${file} must export \`pair\` with original, port and inputs`)
  }

  const outDir = join(term, 'tmp/self-host', options.name)
  const shown = `tmp/self-host/${options.name}`

  mkdirSync(outDir, { recursive: true })

  const show = (input: unknown): string => {
    if (pair.show) return pair.show(input)

    try {
      return JSON.stringify(input) ?? String(input)
    } catch {
      return canon(input)
    }
  }

  const watch = startWatchdog(options.name, options.timeout, options.keep ? null : scratch)
  const hardNames = Object.keys(pair.hard ?? {})
  const hardCounts = new Map<string, number>(hardNames.map(name => [name, 0]))
  const groups = new Map<string, Group>()
  const lines: Array<{ index: number; signature: string; show: string; original: string; port: string }> = []
  let total = 0
  let ran = 0
  let equal = 0
  let bothThrew = 0
  let disagree = 0

  const runCase = async (
    input: unknown,
    index: number,
  ): Promise<{ original: Outcome; port: Outcome; comparison: Comparison }> => {
    const original = await runSide(pair.original as never, input, options.timeout, watch, index, 1)
    const port = await runSide(pair.port as never, input, options.timeout, watch, index, 2)

    return { original, port, comparison: compareOutcomes(original, port, pair.compare) }
  }

  const record = async (input: unknown, index: number): Promise<void> => {
    const result = await runCase(input, index)

    ran++

    if (result.comparison.verdict === 'equal') {
      equal++
      return
    }

    if (result.comparison.verdict === 'both-threw') {
      bothThrew++
      return
    }

    disagree++

    const text = show(input)
    const { signature, path } = result.comparison
    const found: Found = { input, show: text, original: result.original, port: result.port }
    const group = groups.get(signature)

    if (!group) {
      groups.set(signature, { signature, path, count: 1, best: found, letter: '' })
    } else {
      group.count++

      if (text.length < group.best.show.length) group.best = found
    }

    lines.push({
      index,
      signature,
      show: text.length > 300 ? `${text.slice(0, 300)}...` : text,
      original: brief(result.original),
      port: brief(result.port),
    })
  }

  // one pass over every input: the hard cases are counted over ALL of them, the cases run are all of them, or the
  // seeded sample of N
  const random = generator(options.seed)
  const reservoir: Array<{ index: number; input: unknown }> = []

  for await (const input of pair.inputs()) {
    const index = total++

    for (const name of hardNames) {
      try {
        if (pair.hard![name]!(input)) hardCounts.set(name, hardCounts.get(name)! + 1)
      } catch {
        // a predicate that throws does not count the case
      }
    }

    if (options.sample === null) {
      await record(input, index)
    } else if (reservoir.length < options.sample) {
      reservoir.push({ index, input })
    } else {
      const slot = Math.floor(random() * (index + 1))

      if (slot < options.sample) reservoir[slot] = { index, input }
    }
  }

  if (options.sample !== null) {
    reservoir.sort((a, b) => a.index - b.index)

    for (const entry of reservoir) await record(entry.input, entry.index)
  }

  // minimize each signature's input while its signature holds
  const ordered = [...groups.values()].sort((a, b) => b.count - a.count)

  for (const group of ordered) {
    if (!pair.shrink) continue

    let tries = 0
    let improved = true

    while (improved && tries < SHRINK_TRIES) {
      improved = false

      for (const candidate of pair.shrink(group.best.input)) {
        if (tries >= SHRINK_TRIES) break

        tries++

        const result = await runCase(candidate, -1)

        if (
          result.comparison.verdict === 'disagree' &&
          result.comparison.signature === group.signature
        ) {
          const text = show(candidate)

          if (text.length < group.best.show.length) {
            group.best = { input: candidate, show: text, original: result.original, port: result.port }
            improved = true
            break
          }
        }
      }
    }
  }

  watch.stop()

  ordered.forEach((group, index) => {
    group.letter = letterFor(index)
  })

  // the files: stale fail files of an earlier run are overwritten with a marker, never removed
  const written = new Set<string>()
  const write = (name: string, text: string): void => {
    writeFileSync(join(outDir, name), text)
    written.add(name)
  }

  for (const group of ordered) {
    write(`fail-${group.letter}.json`, inputText(group.best.input))
    write(
      `fail-${group.letter}.diff`,
      unifiedDiff(
        outputText(group.best.original, pair.compare),
        outputText(group.best.port, pair.compare),
        'original',
        'port',
        group.path,
      ),
    )
  }

  for (const name of readdirSync(outDir)) {
    if (/^fail-[a-z]+\.(json|diff)$/.test(name) && !written.has(name)) {
      writeFileSync(join(outDir, name), name.endsWith('.json') ? '{"stale":true}\n' : 'stale\n')
    }
  }

  const letters = new Map(ordered.map(group => [group.signature, group.letter]))

  write(
    'disagree.jsonl',
    lines
      .map(entry =>
        JSON.stringify({
          index: entry.index,
          group: letters.get(entry.signature),
          signature: entry.signature,
          input: entry.show,
          original: entry.original,
          port: entry.port,
        }),
      )
      .map(line => `${line}\n`)
      .join(''),
  )
  write(
    'index.json',
    `${JSON.stringify(
      ordered.map(group => ({
        group: group.letter,
        cases: group.count,
        signature: group.signature,
        input: `fail-${group.letter}.json`,
        diff: `fail-${group.letter}.diff`,
      })),
      null,
      2,
    )}\n`,
  )

  // the verdict
  const zero = hardNames.filter(name => hardCounts.get(name) === 0)
  const reasons: string[] = []

  if (disagree > 0) reasons.push(`disagree ${count(disagree)}`)
  for (const name of zero) reasons.push(`hard case ${name} is 0`)
  if (total === 0) reasons.push('no inputs')

  const pass = reasons.length === 0
  const out: string[] = [`PAIR ${options.name}`, row('inputs:', ran)]

  if (options.sample !== null) {
    out.push(`sample:      ${count(ran)} of ${count(total)}, seed ${options.seed}`)
  }

  out.push(row('equal:', equal), row('both-threw:', bothThrew), row('disagree:', disagree))
  out.push(
    `hard cases:  ${
      hardNames.length === 0
        ? 'none declared'
        : hardNames.map(name => `${name} ${count(hardCounts.get(name)!)}`).join(', ')
    }`,
  )
  out.push(`status: ${pass ? 'PASS' : 'FAIL'}`)

  if (!pass) out.push(`reason: ${reasons.join(', ')}`)

  if (ordered.length > 0) {
    out.push(
      `${count(disagree)} ${disagree === 1 ? 'disagreement' : 'disagreements'}, ${count(ordered.length)} ${ordered.length === 1 ? 'signature' : 'signatures'}`,
    )

    const room = 15 - out.length
    const listed = ordered.length > room ? Math.max(0, room - 1) : ordered.length

    for (const group of ordered.slice(0, listed)) {
      const plural = group.count === 1 ? 'case ' : 'cases'

      out.push(
        `${group.letter.toUpperCase()}  ${count(group.count)} ${plural}  ${shown}/fail-${group.letter}.json  fail-${group.letter}.diff  at ${group.path}`,
      )
    }

    if (listed < ordered.length) {
      out.push(`+${count(ordered.length - listed)} more signatures in ${shown}/index.json`)
    }
  }

  const verdict = `${out.join('\n')}\n`

  writeFileSync(join(outDir, 'verdict.txt'), verdict)
  process.stdout.write(verdict)
  process.exitCode = pass ? 0 : 1
}

// the run's temporary folder, and whether --keep keeps it
let scratch: string | null = null
let keep = false

function closeScratch(): void {
  if (scratch === null) return

  if (keep) {
    process.stderr.write(`kept: ${scratch}\n`)
  } else {
    removeTree(scratch)
    // once more, for a removal that raced a side's child still writing into it
    removeOwnRuns()
  }

  scratch = null
}

process.on('exit', closeScratch)

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    closeScratch()
    process.exit(signal === 'SIGINT' ? 130 : 143)
  })
}

main()
  .catch((cause: unknown) => {
    console.error(cause)
    process.exitCode = 2
  })
  .finally(closeScratch)
