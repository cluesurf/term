// verb-pair: the shipped `term` against the current one, command line by command line.
//
// The CLI is being rewritten in Term (note/project/term/cli-in-term/). Every unit of that work has to leave what a
// person sees unchanged, so the proof is behavioural: the binary that shipped before anything changed and the binary
// built now run the same command lines over the same fixture projects, and they must agree on the exit code, the
// stdout, the stderr and every file each run wrote.
//
// THE BASELINE is a create-only copy of host/ taken on 2026-10-23, before the switch, in
// tmp/retired/line/2026-10-23/. It cannot run from there: line.js finds its package by paths
// relative to itself (`../package.json` is its version, `<up 4>/zone/...` the zone console, `../deck/mark` the
// benchmark suite), and from tmp/retired/line/<date>/ every one of those is wrong (it said `term 0.0.0` and "There is
// no zone console here"). So it runs from a STAGE, tmp/verb-pair/pair/at/stagea/, at the depth host/ sits at: a real
// copy of the baseline as stagea/host/, and every other top-level entry of the package (deck, node_modules,
// package.json, ...) a symlink to the real one. THE CURRENT BINARY RUNS FROM A STAGE TOO, tmp/verb-pair/pair/at/stageb/,
// its host/ folder copied fresh each run, for the width of the line: the CLI wraps every item at 80 columns when stderr
// is not a terminal, so a path 20 characters longer on one side broke its lines at other places, and no replacement of
// the stage's path could join them again. Two stages of one length wrap alike, and each stage's path reads as `<term>`.
// And for the zone console: from either stage `host/<up 4>/zone` is tmp/verb-pair/zone, a frozen console both
// sides share (decision cli-in-term/018 part 4), where from the real host/ it is the live deck/zone.
//
// GENERATED ROWS, one or more for EVERY TAKE OF EVERY COMMAND (decision cli-in-term/013 part 2). The takes are read from
// the console's routes (task/term/take-reach.ts --routes, the routes cli-drift reads), never from line.ts: a boolean take
// is its flag alone (`make --units`), a take with choices is each choice and one value outside them, and any other take
// is its line in task/term/verb-pair-flags.txt, in the row format below, or `skip <verb path> --<take> <reason>` there
// (network, publishing, signing, a device). A skip line also stops a boolean's or a choice's generated row. A take with
// neither stops verb-pair before any run, naming it. The hand rows of verb-pair.txt keep their line numbers; the
// generated rows run after them, numbered from 1001 (flags and choices) and 2001 (verb-pair-flags.txt, by its line), and
// a disagreement's folder under diff/ is named `<verb> --<take>` (with the value for a choice row).
//
// Rows are task/term/verb-pair.txt: `<fixture> [NAME=value ...] <arguments>`, one per line, `#` comments. A fixture is
// a folder under tmp/verb-pair/fixture/, copied fresh for every run of every side (`empty` is an empty folder). Each
// run gets its own HOME, so nothing reads or writes the person's ~/.base, and the environment loses every variable
// whose name says KEY, TOKEN, SECRET or PASSWORD, so no run can reach a paid or signed service by accident.
//
// Normalized before comparing, and nothing else: durations (and clock readings), the run's temporary paths (and the
// stage's), and pids. What the binary itself makes differ from run to run is held still instead, the same for both
// sides: the clock, Math.random and randomUUID (clock()), and the signing key (keyText()). Both sides of a row run at
// one path, one after the other.
//
//   pnpm --dir <repo> exec tsx task/term/verb-pair.ts                 every row
//   ... --only make,base                                              the rows of those verbs
//   ... --sample 200 --seed 7                                         a seeded sample of the rows
//   ... --current <path to line.js>                                   another current binary (default host/line.js)
//   ... --jobs N                                                      rows run at once (default 4)
//   ... --list                                                        print the rows and the uncovered verbs, run none
//   ... --show <line>                                                 one row's baseline run, printed whole
//
// Prints at most 15 lines. Diffs of every disagreement land in tmp/verb-pair/diff/<row>/; the
// files of an earlier run's disagreement are overwritten with `stale`, never removed. Exit 1 on any disagreement or
// any verb of `term --help` without both a `--help` row and a real row.

import { spawn, spawnSync, execFileSync } from 'node:child_process'
import { createHash, createPrivateKey, createPublicKey } from 'node:crypto'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { gunzipSync } from 'node:zlib'
import { unifiedDiff } from './pair/canon'
import { TERM_ROOT } from './root'

const REPO = TERM_ROOT
const TERM = TERM_ROOT
const BASELINE = join(TERM, 'tmp/retired/line/2026-10-23')
const OUT = join(TERM, 'tmp/verb-pair')
// two names of one length (see above), each one word no wrap can split, so a path the 80 columns did break is still
// told apart by `stagea` / `stageb` alone, which normalize() reads as one. Each stage sits four folders under OUT, so
// `host/<up 4>/zone`, where both CLIs look for the zone console first, is OUT/zone: the frozen one below
const WAS = join(OUT, 'pair/at/stagea')
const NOW = join(OUT, 'pair/at/stageb')
const FIXTURES = join(OUT, 'fixture')
// THE FROZEN ZONE CONSOLE (decision cli-in-term/018 part 4). deck/zone's console was rewritten after the baseline froze
// (2026-10-23 17:45, term/decision/003), and the baseline reads the new shape as one command named zone, so both sides
// boot one checked-in console in the flat shape instead. It is copied once to ZONE, create-only, with the
// link/@term/base deck/zone has, and checked at every run, as decision 015 does the baseline's yargs
const ZONE_FROM = join(FIXTURES, 'zone')
const ZONE = join(OUT, 'zone')
const DIFF = join(OUT, 'diff')
const ROWS = join(REPO, 'task/term/verb-pair.txt')
const FLAGS = join(REPO, 'task/term/verb-pair-flags.txt')
const TAKE_REACH = join(REPO, 'task/term/take-reach.ts')
// a value outside every choice of a take, for the row that must be refused
const OUTSIDE = 'not-a-choice'
const TIMEOUT_MS = 120_000
const CLOCK = join(OUT, 'clock.mjs')
// THE BASELINE'S OWN YARGS (decision cli-in-term/015). line.js was bundled with --packages=external, so the yargs it
// imports is part of what it witnesses: 17.7.2, whose cliui wraps help hard, where the repository root's 18.0.0 wraps
// at words. Its closure is copied once, as real files, into the baseline's node_modules, and every run checks that the
// staged baseline resolves it
const YARGS_VERSION = '17.7.2'
const YARGS_FROM = join(REPO, `node_modules/.pnpm/yargs@${YARGS_VERSION}/node_modules/yargs`)

// verbs that only ever get a `--help` row, each with the reason: a NAMED exception, checked, never a silent hole
const HELP_ONLY: Record<string, string> = {
  work: 'cli-in-term/decision/013 part 2: the long-lived compiler worker serves until killed, so a run has no exit to compare',
}

// rows where the console differs from the baseline ON PURPOSE, keyed by the row's text, each with the decision that
// says so (a `Diverges:` line). A disagreement on such a row is counted `explained`, never a failure; a row here that
// reads equal is reported, so the entry cannot outlive its cause
const DIVERGES: Record<string, string> = {
  'empty fill --help':
    "cli-in-term/decision/011: yargs' .completion('fill') printed the completion script for fill --help; the console prints fill's help",
  'hello test':
    "cli-in-term/decision/009: term test bundles its module under the project's cache/test (the kept bundle, its inputs, its run folders, the install's node_modules linked beside it) where the baseline wrote one entry and used the system temp folder",
  // the generated rows of `test` that run tests in the hello fixture write the same cache/test as row 98
  'hello test double': 'cli-in-term/decision/009: as hello test (the generated row of test --filter)',
  'hello test --case doubles': 'cli-in-term/decision/009: as hello test (the generated row of test --case)',
  'hello test --merged': 'cli-in-term/decision/009: as hello test (the generated row of test --merged)',
  'hello test --update': 'cli-in-term/decision/009: as hello test (the generated row of test --update)',
  // the snapshot store the row exists for (test/greet.snapshot.tree) is in its files and reads equal; only cache/test
  // differs (term-cli-in-term-0194)
  'snap test --update': 'cli-in-term/decision/009: as hello test (the hand row of test --update with a snapshot to write)',
  // feed's takes name the `term boot` line that replaces it, and note reads the package its slot names
  'hello feed code/absent.tree':
    "cli-in-term/decision/017: the refusal's next is the term boot line that replaces the retired one (term boot moon code/absent.tree), where the baseline named the two modes",
  'hello feed --port 9':
    "cli-in-term/decision/017: the refusal's next is term boot moon -p 9, where the baseline named the two modes",
  'hello feed --env node':
    "cli-in-term/decision/017: the refusal's next is term boot moon --env node, where the baseline named the two modes",
  'hello note @term/base':
    "cli-in-term/decision/017: the card of @term/base, the package the slot names, where the baseline printed hello's own",
  'empty knit a --law x b':
    "cli-in-term/decision/012: yargs read the array option --law greedily (law [x, b], spec [a]); the console reads one word per --law and interleaves flags with the list slot's words (spec [a, b], law [x])",
  // the one zone row the frozen console cannot make agree (decision 018 part 4): a list slot without `mark pass`
  'empty zone call dev node -e x':
    'cli-in-term/decision/012: yargs passed -e on to call\'s list and ran it (exit 3); the dispatcher halts at the first positional only for a list slot marked pass, and the flat console\'s is not, so it refuses the unknown flag -e (exit 2)',
}

// `name` is a generated row's name, `<verb path> --<take>`, which names its folder under diff/
export type Row = {
  line: number
  fixture: string
  env: Record<string, string>
  args: string[]
  verb: string
  text: string
  name?: string
}
type Run = { exit: string; stdout: string; stderr: string; files: Map<string, string> }

function flag(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`)

  return at === -1 ? undefined : process.argv[at + 1]
}

// one row's words, with '...' and "..." holding spaces
function words(text: string): string[] {
  const out: string[] = []

  for (const found of text.matchAll(/'([^']*)'|"([^"]*)"|(\S+)/g)) {
    out.push(found[1] ?? found[2] ?? (found[3] as string))
  }

  return out
}

// one row's text: `<fixture> [NAME=value ...] <arguments>`
function rowOf(text: string, line: number): Row {
  const [fixture, ...rest] = words(text)
  const env: Record<string, string> = {}

  while (rest.length > 0 && /^[A-Z_][A-Z0-9_]*=/.test(rest[0] as string)) {
    const [name, ...value] = (rest.shift() as string).split('=')
    env[name as string] = value.join('=')
  }

  // the verb is the first word that is not a flag; `--help` alone and `--version` are the top level's
  const verb = rest.find(word => !word.startsWith('-')) ?? '(top)'

  return { line, fixture: fixture as string, env, args: rest, verb, text }
}

export function readRows(): Row[] {
  const rows: Row[] = []

  readFileSync(ROWS, 'utf8')
    .split('\n')
    .forEach((raw, index) => {
      const text = raw.trim()

      if (text === '' || text.startsWith('#')) {
        return
      }

      rows.push(rowOf(text, index + 1))
    })

  return rows
}

// ---- the generated rows: every take of every command, from the console's routes ----

export type RouteTake = {
  name: string
  kind: string
  positional: boolean
  list: boolean
  maybe: boolean
  choices: string[]
  short?: string
}

export type RouteCommand = { path: string; task?: string; passes: boolean; takes: RouteTake[] }

// the console's commands and their takes, as the dispatcher reads them: task/term/take-reach.ts compiles
// deck/call/code/line/base.tree through the compiler and prints its routes. It runs from the term package under the
// loader this process runs under (tsx), so its @term imports resolve as cli-drift's do
export function readRoutes(): RouteCommand[] {
  const run = spawnSync(process.execPath, [...process.execArgv, TAKE_REACH, '--routes'], {
    cwd: TERM,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })

  if (run.status !== 0) {
    const reason = run.stderr.split('\n').find(line => line.startsWith('Error')) ?? run.stderr.slice(0, 400)

    throw new Error(`the console's routes could not be read (take-reach.ts --routes): ${reason}`)
  }

  return JSON.parse(run.stdout) as RouteCommand[]
}

// the command a row's arguments run, the longest path its leading words name (flags before it are the program's), and
// the words after that path
export function commandOf(commands: RouteCommand[], args: string[]): { command: RouteCommand; rest: string[] } | undefined {
  let at = 0

  while (at < args.length && (args[at] as string).startsWith('-')) {
    at++
  }

  let best: RouteCommand | undefined

  for (const command of commands) {
    const path = command.path.split(' ')

    if (path.every((word, index) => args[at + index] === word) && (!best || path.length > best.path.split(' ').length)) {
      best = command
    }
  }

  return best ? { command: best, rest: args.slice(at + best.path.split(' ').length) } : undefined
}

// the takes a command's words pass, read as the dispatcher reads them: a `--name`, `--name=value`, `--no-name` or `-s`
// word names a take (a value take consumes the next word), every other word fills the next slot (a list slot takes
// every one left), and after `--` every word is a slot's. A passing command (`mark pass`) hands every word to its slot
export function takesPassed(command: RouteCommand, rest: string[]): string[] {
  const out = new Set<string>()
  const slots = command.takes.filter(take => take.positional)

  if (command.passes) {
    if (rest.length > 0 && slots[0]) {
      out.add(slots[0].name)
    }

    return [...out]
  }

  let slot = 0
  let flags = true

  for (let at = 0; at < rest.length; at++) {
    const word = rest[at] as string

    if (flags && word === '--') {
      flags = false
      continue
    }

    if (flags && word.startsWith('-') && word.length > 1) {
      const long = word.startsWith('--')
      const [head, ...valued] = (long ? word.slice(2) : word.slice(1)).split('=')
      const options = command.takes.filter(take => !take.positional)
      const take = long
        ? (options.find(one => one.name === head) ??
          options.find(one => one.kind === 'boolean' && `no-${one.name}` === head))
        : options.find(one => one.short === head)

      if (take) {
        out.add(take.name)

        if (take.kind !== 'boolean' && valued.length === 0) {
          at++
        }
      }

      continue
    }

    const into = slots[slot]

    if (into) {
      out.add(into.name)

      if (!into.list) {
        slot++
      }
    }
  }

  return [...out]
}

export type Plan = {
  // the generated rows, after the hand rows
  rows: Row[]
  // `<verb path> --<take>` to the reason it has no row
  skipped: Map<string, string>
  // `<verb path> --<take>` of every take with no row and no skip
  missing: string[]
  // `<verb path> --<take>` of every take some row passes (hand or generated)
  covered: Set<string>
  // every take of every command
  takes: string[]
}

function keyOf(path: string, take: string): string {
  return `${path} --${take}`
}

// the rows the routes call for, the skips, and every take with neither
export function planRows(hand: Row[], commands: RouteCommand[]): Plan {
  const skipped = new Map<string, string>()
  const flagRows: Row[] = []
  const lines = existsSync(FLAGS) ? readFileSync(FLAGS, 'utf8').split('\n') : []

  lines.forEach((raw, index) => {
    const text = raw.trim()

    if (text === '' || text.startsWith('#')) {
      return
    }

    // skip <verb path> --<take> <reason>
    if (text.startsWith('skip ')) {
      const parts = text.slice(5).trim().split(/\s+/)
      const flagAt = parts.findIndex(word => word.startsWith('--'))

      if (flagAt < 1 || parts.length <= flagAt + 1) {
        throw new Error(`${FLAGS}:${index + 1}: a skip is 'skip <verb path> --<take> <reason>'`)
      }

      skipped.set(keyOf(parts.slice(0, flagAt).join(' '), (parts[flagAt] as string).slice(2)), parts.slice(flagAt + 1).join(' '))

      return
    }

    flagRows.push(rowOf(text, 2000 + index + 1))
  })

  // the fixture a command's generated rows run in: its first real hand row's, else its verb's, else an empty folder
  const fixtureOf = (command: RouteCommand): string => {
    const real = hand.filter(row => !row.args.includes('--help'))
    const own = real.find(row => commandOf(commands, row.args)?.command.path === command.path)
    const verb = real.find(row => row.verb === command.path.split(' ')[0])

    return own?.fixture ?? verb?.fixture ?? 'empty'
  }

  const generated: Row[] = []
  const takes: string[] = []
  const passed = (row: Row): string[] => {
    const found = commandOf(commands, row.args)

    return found ? takesPassed(found.command, found.rest).map(take => keyOf(found.command.path, take)) : []
  }

  for (const command of commands) {
    for (const take of command.takes) {
      const key = keyOf(command.path, take.name)
      takes.push(key)

      if (skipped.has(key)) {
        continue
      }

      const make = (args: string[], name: string): void => {
        const fixture = fixtureOf(command)
        const all = [...command.path.split(' '), ...args]
        generated.push({
          line: 1001 + generated.length,
          fixture,
          env: {},
          args: all,
          verb: command.path.split(' ')[0] as string,
          text: `${fixture} ${all.join(' ')}`,
          name,
        })
      }

      if (!take.positional && take.kind === 'boolean') {
        make([`--${take.name}`], key)
      } else if (!take.positional && take.choices.length > 0) {
        for (const choice of [...take.choices, OUTSIDE]) {
          make([`--${take.name}`, choice], `${key} ${choice}`)
        }
      }
    }
  }

  // a verb-pair-flags.txt row is named for the first take it passes
  const named = new Map<string, number>()

  for (const row of flagRows) {
    const first = passed(row)[0]
    const base = first ?? `row ${row.line}`
    const seen = (named.get(base) ?? 0) + 1
    named.set(base, seen)
    row.name = seen === 1 ? base : `${base} ${seen}`
  }

  const rows = [...generated, ...flagRows]
  const covered = new Set<string>()

  for (const row of [...hand, ...rows]) {
    for (const key of passed(row)) {
      covered.add(key)
    }
  }

  // a value take or a slot needs a line of verb-pair-flags.txt (or a skip); a hand row passing it does not stand in
  const fromFlags = new Set(flagRows.flatMap(passed))
  const missing = takes.filter(key => {
    if (skipped.has(key)) {
      return false
    }

    const [path, take] = key.split(' --') as [string, string]
    const shape = commands.find(command => command.path === path)?.takes.find(one => one.name === take)

    if (shape && !shape.positional && (shape.kind === 'boolean' || shape.choices.length > 0)) {
      return false
    }

    return !fromFlags.has(key)
  })

  return { rows, skipped, missing, covered, takes }
}

// mulberry32: a seeded sample is the same sample on every machine
function random(seed: number): () => number {
  let state = seed >>> 0

  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// a stage: every top-level entry of the package but host/ and tmp/ linked in, and the given host folder copied in
function stage(dir: string, host: string, fresh: boolean): void {
  mkdirSync(dir, { recursive: true })

  for (const name of readdirSync(TERM)) {
    if (name === 'host' || name === 'tmp') {
      continue
    }

    const at = join(dir, name)
    let present = true

    try {
      lstatSync(at)
    } catch {
      present = false
    }

    if (!present) {
      symlinkSync(join(TERM, name), at)
    }
  }

  const into = join(dir, 'host')

  if (fresh || !existsSync(join(into, 'line.js'))) {
    cpSync(host, into, { recursive: true, force: true, preserveTimestamps: true })
  }

  // a stage made before its host had node_modules (the baseline's yargs, decision 015) is refreshed with it
  if (existsSync(join(host, 'node_modules')) && !existsSync(join(into, 'node_modules'))) {
    cpSync(join(host, 'node_modules'), join(into, 'node_modules'), { recursive: true, preserveTimestamps: true })
  }

  // the staged copy must be its source, byte for byte
  for (const name of ['line.js', 'dock.mjs', 'need.mjs', 'need-hand.mjs']) {
    if (existsSync(join(host, name)) && hashFile(join(into, name)) !== hashFile(join(host, name))) {
      throw new Error(`${join(into, name)} is not ${join(host, name)}: move the stage aside and run again`)
    }
  }
}

// a package's folder as `require` from `from` finds it: by `<name>/package.json` where the package exports it, else by
// the node_modules folders Node walks from `from` (cliui 8 exports no package.json)
function packageDir(name: string, from: string): string {
  const require = createRequire(join(from, 'package.json'))

  try {
    return realpathSync(dirname(require.resolve(`${name}/package.json`)))
  } catch {
    for (const folder of require.resolve.paths(name) ?? []) {
      if (existsSync(join(folder, name, 'package.json'))) {
        return realpathSync(join(folder, name))
      }
    }
  }

  throw new Error(`${name} is not reachable from ${from}`)
}

// the baseline's yargs closure, copied once as real files into <baseline>/node_modules, flat, each package the
// version the 17.7.2 install resolved; create-only (tmp/retired is), and two versions of one name stop the copy
function vendorYargs(): void {
  const into = join(BASELINE, 'node_modules')

  if (existsSync(join(into, 'yargs'))) {
    return
  }

  if (!existsSync(join(YARGS_FROM, 'package.json'))) {
    throw new Error(`no yargs ${YARGS_VERSION} at ${YARGS_FROM} to give the baseline (decision cli-in-term/015)`)
  }

  const found = new Map<string, { version: string; dir: string }>()
  const queue = [realpathSync(YARGS_FROM)]

  while (queue.length > 0) {
    const dir = queue.shift() as string
    const card = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as {
      name: string
      version: string
      dependencies?: Record<string, string>
    }
    const had = found.get(card.name)

    if (had !== undefined) {
      if (had.version !== card.version) {
        throw new Error(
          `the yargs ${YARGS_VERSION} closure holds two versions of ${card.name}: ${had.version} (${had.dir}) and ${card.version} (${dir})`,
        )
      }

      continue
    }

    found.set(card.name, { version: card.version, dir })

    for (const name of Object.keys(card.dependencies ?? {})) {
      queue.push(packageDir(name, dir))
    }
  }

  for (const [name, { dir }] of found) {
    const at = join(into, name)

    if (existsSync(at)) {
      throw new Error(`${at} exists and ${into}/yargs does not: the copy is half made, move ${into} aside`)
    }

    cpSync(dir, at, { recursive: true, dereference: true, errorOnExist: true, force: false, preserveTimestamps: true })
  }
}

// the staged baseline must import yargs 17.7.2 from its own node_modules, or every help row reads another yargs' wrap
function baselineYargs(): string | undefined {
  if (!existsSync(join(WAS, 'host/node_modules/yargs/package.json'))) {
    return `the staged baseline has no ${join(WAS, 'host/node_modules/yargs')}`
  }

  const own = realpathSync(join(WAS, 'host/node_modules'))
  let resolved: string

  try {
    resolved = realpathSync(createRequire(join(WAS, 'host/line.js')).resolve('yargs'))
  } catch (error) {
    return `yargs does not resolve from ${join(WAS, 'host/line.js')}: ${(error as Error).message.split('\n')[0]}`
  }

  if (!resolved.startsWith(`${own}/yargs/`)) {
    return `yargs resolves from ${join(WAS, 'host/line.js')} to ${resolved}, not under ${own}/yargs`
  }

  const version = (JSON.parse(readFileSync(join(own, 'yargs/package.json'), 'utf8')) as { version: string }).version

  return version === YARGS_VERSION ? undefined : `the staged baseline's yargs is ${version}, not ${YARGS_VERSION}`
}

// the fixture's files, as paths relative to it, every folder walked; a link inside it is refused
function zoneFiles(dir: string, prefix = ''): string[] {
  const out: string[] = []

  for (const name of readdirSync(join(dir, prefix)).sort()) {
    const at = join(prefix, name)
    const info = lstatSync(join(dir, at))

    if (info.isSymbolicLink()) {
      throw new Error(`${join(dir, at)} is a link: the frozen zone console holds real files only`)
    }

    if (info.isDirectory()) {
      out.push(...zoneFiles(dir, at))
    } else {
      out.push(at)
    }
  }

  return out
}

// the frozen zone console, copied once to ZONE (create-only: an existing file is never written) with deck/zone's
// link/@term/base beside it
function stageZone(): void {
  for (const file of zoneFiles(ZONE_FROM)) {
    if (!existsSync(join(ZONE, file))) {
      mkdirSync(dirname(join(ZONE, file)), { recursive: true })
      cpSync(join(ZONE_FROM, file), join(ZONE, file), { errorOnExist: true, force: false, preserveTimestamps: true })
    }
  }

  const link = join(ZONE, 'link/@term/base')
  let present = true

  try {
    lstatSync(link)
  } catch {
    present = false
  }

  if (!present) {
    mkdirSync(dirname(link), { recursive: true })
    symlinkSync(join(TERM, 'deck/base'), link)
  }
}

// at every run: the staged console is the fixture, byte for byte, nothing more, and its stdlib link is the real one,
// or every zone row compares something else
function frozenZone(): string | undefined {
  const want = zoneFiles(ZONE_FROM)
  const linked = join(ZONE, 'link/@term/base')

  for (const file of want) {
    if (!existsSync(join(ZONE, file)) || hashFile(join(ZONE, file)) !== hashFile(join(ZONE_FROM, file))) {
      return `${join(ZONE, file)} is not ${join(ZONE_FROM, file)}: move ${ZONE} aside and run again`
    }
  }

  // link/ is the stdlib's, and a boot may leave its build (host/) and its cache (.base/) beside the console
  const made = ['link', 'host', '.base']
  const extra = readdirSync(ZONE).filter(name => !made.includes(name) && !want.some(file => file.split('/')[0] === name))

  if (extra.length > 0) {
    return `${ZONE} holds ${extra.join(', ')}, which the fixture does not: move ${ZONE} aside and run again`
  }

  if (!existsSync(linked) || realpathSync(linked) !== realpathSync(join(TERM, 'deck/base'))) {
    return `${linked} does not reach ${join(TERM, 'deck/base')}`
  }

  return undefined
}

function hashFile(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

// THE CLOCK IS STOPPED in every run of both sides, at 2026-01-01T00:00:00Z, by a module NODE_OPTIONS imports into
// every node process the run starts. The shipped binary is not deterministic on its own: `term host --dry` signs a
// commit with the time it was made, so its digests change from one run to the next, `term knit` names its run by the
// time, and the test cache writes it. A stopped clock is a normalized one, read before anything is printed; every
// duration reads 0, and is normalized as one anyway.
function clock(): string {
  const file = join(OUT, 'clock.mjs')
  const text = [
    '// written by task/term/verb-pair.ts: the stopped clock of every verb-pair run',
    'const FIXED = Date.UTC(2026, 0, 1)',
    'const Real = Date',
    'class Stopped extends Real {',
    '  constructor(...args) { if (args.length === 0) super(FIXED); else super(...args) }',
    '  static now() { return FIXED }',
    '}',
    'globalThis.Date = Stopped',
    '// and the dice: a uuid (`term base init` names the repository by one) and Math.random follow one fixed sequence',
    "import crypto from 'node:crypto'",
    "import { syncBuiltinESMExports } from 'node:module'",
    'let state = 0x9e3779b9',
    'const next = () => {',
    '  state = (state + 0x6d2b79f5) >>> 0',
    '  let t = state',
    '  t = Math.imul(t ^ (t >>> 15), t | 1)',
    '  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)',
    '  return ((t ^ (t >>> 14)) >>> 0) / 4294967296',
    '}',
    'Math.random = next',
    'crypto.randomUUID = () => {',
    "  const hex = Array.from({ length: 32 }, () => Math.floor(next() * 16).toString(16)).join('')",
    "  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${'89ab'[Math.floor(next() * 4)]}${hex.slice(17, 20)}-${hex.slice(20, 32)}`",
    '}',
    'syncBuiltinESMExports()',
    '',
  ].join('\n')

  if (!existsSync(file) || readFileSync(file, 'utf8') !== text) {
    writeFileSync(file, text)
  }

  return file
}

// the verbs `term --help` lists, from the baseline: what every pair must cover
function shippedVerbs(cli: string): string[] {
  let text: string

  try {
    text = execFileSync('node', [cli, '--help'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  } catch (cause) {
    text = (cause as { stdout?: string }).stdout ?? ''
  }

  return [...new Set([...text.matchAll(/^ {2,}term ([a-z][a-z-]*)/gm)].map(m => m[1] as string))]
}

// `stdlib` is the side's TERM_STDLIB (environment())
type Side = { name: string; cli: string; replace: [string, string][]; stdlib: string }

// durations, the run's temporary paths, pids, and the heap readings of `time --memory`: nothing else
function normalize(text: string, replace: [string, string][]): string {
  let out = text

  for (const [from, to] of replace) {
    out = out.split(from).join(to)
  }

  // a clock reading (`00:51:24.653`, the time an item ended) is a duration from midnight: it is read as one
  return out
    .replace(/\bstage[ab]\b/g, 'stage<side>')
    // A STAGE'S PATH THAT THE 80 COLUMNS BROKE reads as `<term>`, as it does whole (the stages above). Every side names
    // its install root in `self list` / `self show` (decision cli-in-term/006): the baseline finds it by walking up from
    // itself, so it is its stage, and the console takes TERM_STDLIB first, which environment() pins to the real
    // deck/base. Since term-cli-in-term-0227 the current side's TERM_STDLIB is its own stage's, so both print their
    // stage. Outside the harness both print the install root. Only the stage's own segments, each split at a slash with
    // the CLI's indent after it, are joined (term-cli-in-term-0219)
    .replace(
      /<term>\/(?:\n +)?tmp\/(?:\n +)?verb-pair\/(?:\n +)?pair\/(?:\n +)?at\/(?:\n +)?stage<side>(?=\/|\s|$)/g,
      '<term>',
    )
    .replace(/\b\d{2}:\d{2}:\d{2}(?:\.\d+)?\b/g, '<clock>')
    .replace(/\b\d+(?:\.\d+)?\s?(?:ns|µs|us|ms|s)\b/g, '<time>')
    .replace(/\b\d+m(?: ?<time>)/g, '<time>')
    // a folder mkdtemp made under the run's TMPDIR ends in six random characters, absolute or relative to the work
    // folder (esbuild names a bundled module by its relative path in a comment: `// ../tmp/seed-test-gb0AFJ/...`)
    .replace(/((?:<run>|\.\.)\/tmp\/[A-Za-z][\w.]*(?:-[A-Za-z][\w.]*)*-)[A-Za-z0-9]{6}\b/g, '$1<rand>')
    // a duration as a JSON number keyed by its unit (`term hunt --json`: "ms": 269.08), read by the generated rows
    .replace(/"(ms|seconds|duration_ms)":\s*-?\d+(?:\.\d+)?(?:e-?\d+)?/g, '"$1":<time>')
    // a list of files ordered by their measured time (`term hunt --json` corpus.slowest), which two runs of ONE binary
    // order apart (the baseline paired with itself swapped two files, term-cli-in-term-0194): read sorted by file
    .replace(
      /\[(\s*\{\s*"file": "[^"]*",\s*"ms":<time>\s*\}(?:,\s*\{\s*"file": "[^"]*",\s*"ms":<time>\s*\})*)(\s*)\]/g,
      (_all, body: string, tail: string) => {
        const items = body.split(/,(?=\s*\{)/)
        const leads = items.map(one => (one.match(/^\s*/) as RegExpMatchArray)[0])
        const sorted = items.map(one => one.trim()).sort()

        return `[${sorted.map((one, index) => `${leads[index]}${one}`).join(',')}${tail}]`
      },
    )
    // a heap reading of `term time --memory`, which no two runs of one binary agree on: only on its own labeled lines
    .replace(/^(\s*(?:heap before|heap after|retained|rss):\s*)-?\d+(?:\.\d+)?\s?[KMG]?B\b/gm, '$1<bytes>')
    .replace(/\bpid([ :=]+)\d+/gi, 'pid$1<pid>')
    .replace(/"pid":\s*\d+/g, '"pid":<pid>')
}

// THE COMPILER'S OWN OUTPUT in a cache is compared by WHAT it was made from, never by what it holds. A unit entry
// (`.base/@term/code/base/unit/`, and a project cache's `unit/`) is the emitted code of the source files it names, and
// a mill entry the parsed program of one source. Both binaries bundle the compiler of their day, and the compiler
// moves on under its own project and its own gates (term:separate-diff, term:test), so on 2026-10-23 40 unit entries
// differed only because compile/bind.tree began grouping a bind's argument (term-compiler-0046: `thing: $reason` is
// `thing: ("...")`), which no console change could match (term-cli-in-term-0185). A unit entry reads as the sorted
// source paths it holds (`unit <path> ...`), one that only points at another as `unit pointer`, a mill entry as
// whether it milled (`mill ok`); the entries' count and kinds are still compared. Anything unreadable keeps its hash
// An EXPLAIN entry (`cache/explain/`, `term make --explain`) is the same kind of thing: the inputs one unit was built
// from, beside the compiler's identity, which hashes where the CLI runs from, so the two stages of one binary wrote it
// apart (`make --explain`, 2026-10-23, term-cli-in-term-0191). It reads as the sorted files the unit was built from
const COMPILED = /\.base\/@term\/code\/(?:base|cache)\/(?:unit|mill|explain)\//

function compiledOf(bytes: Buffer): string {
  try {
    const raw = bytes[0] === 0x1f && bytes[1] === 0x8b ? gunzipSync(bytes).toString('utf8') : bytes.toString('utf8')
    const value = JSON.parse(raw) as { portable?: unknown; ok?: unknown; compiler?: unknown; own?: unknown }

    if (typeof value.ok === 'boolean') {
      return `mill ${value.ok ? 'ok' : 'refused'}`
    }

    if (typeof value.compiler === 'string' && Array.isArray(value.own)) {
      return `explain ${value.own.map(one => String((one as unknown[])[0])).sort().join(' ')}`
    }

    if (typeof value.portable === 'string') {
      let portable: unknown

      try {
        portable = JSON.parse(value.portable)
      } catch {
        return 'unit pointer'
      }

      const files = (portable as { files?: unknown } | null)?.files

      if (!Array.isArray(files)) {
        return 'unit pointer'
      }

      return `unit ${files.map(one => String((one as unknown[])[0])).sort().join(' ')}`
    }
  } catch {
    // not the compiler's JSON: compared by its bytes below
  }

  return createHash('sha256').update(bytes).digest('hex').slice(0, 16)
}

// THE OBLIGATION CACHE (`.base/@term/code/hold/obligations.json`, term hold) is one map written in the order its
// verdicts landed, and each key hashes the toolchain's version, which holds where the CLI runs from (as the cache
// entries' names do, above), so the two stages of one binary keyed every verdict apart (`hold --cross`, 2026-10-23,
// term-cli-in-term-0191). It reads as its verdicts alone, each with its fields sorted, in order of label
function obligationsOf(text: string): string {
  try {
    const value = JSON.parse(text) as Record<string, Record<string, unknown>>
    const sorted = Object.values(value)
      .map(verdict => {
        const backends = verdict.backends as Record<string, unknown> | undefined
        const fields = { ...verdict, ...(backends ? { backends: Object.fromEntries(Object.entries(backends).sort()) } : {}) }

        return JSON.stringify(Object.fromEntries(Object.entries(fields).sort()))
      })
      .sort()

    return `[${sorted.join(',')}]`
  } catch {
    return createHash('sha256').update(text).digest('hex').slice(0, 16)
  }
}

function snapshot(dir: string, prefix: string, replace: [string, string][], into: Map<string, string>): void {
  if (!existsSync(dir)) {
    return
  }

  for (const name of readdirSync(dir).sort()) {
    const at = join(dir, name)
    const key = `${prefix}/${name}`
    const info = lstatSync(at)

    if (info.isSymbolicLink()) {
      into.set(key, `-> ${normalize(readlinkSync(at), replace)}`)
    } else if (info.isDirectory()) {
      snapshot(at, key, replace, into)
    } else if (COMPILED.test(key) && !name.startsWith('.')) {
      into.set(key, normalize(compiledOf(readFileSync(at)), replace))
    } else if (key.endsWith('/hold/obligations.json')) {
      into.set(key, normalize(obligationsOf(readFileSync(at, 'utf8')), replace))
    } else {
      const bytes = readFileSync(at)
      const text = bytes.includes(0) ? undefined : bytes.toString('utf8')
      const body = text === undefined ? bytes : Buffer.from(normalize(text, replace))
      into.set(key, createHash('sha256').update(body).digest('hex').slice(0, 16))
    }
  }
}

// a copy of the environment that can reach nothing paid or signed, with the run's own HOME
function environment(home: string, temp: string, row: Row, side: Side): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}

  for (const [name, value] of Object.entries(process.env)) {
    if (!/KEY|TOKEN|SECRET|PASSWORD/i.test(name)) {
      env[name] = value
    }
  }

  return {
    ...env,
    HOME: home,
    TMPDIR: temp,
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_CONFIG_HOME: join(home, '.config'),
    NO_COLOR: '1',
    FORCE_COLOR: '0',
    TERM_NEED: 'local',
    NODE_OPTIONS: `--import=${pathToFileURL(CLOCK).href}`,
    // THE STDLIB BY ITS REAL PATH, FOR THE BASELINE. A staged CLI finds the stdlib by walking up from itself, through
    // the stage's `deck` link, and until term-compiler-0067 the stdlib and sibling resolvers answered that lexical path
    // while a relative load was canonicalized: one deck under two roots, and the mark console's boot lost
    // `parse-integer` (term-cli-in-term-0185). The current CLI answers the real path from every resolver
    // (make/code/resolve.ts) and boots without this pin, but the baseline binary predates the fix and still fails rows
    // 30 and 100 without it (exit 1 vs 0, 2026-10-23). Drop it once the baseline is a build with 0067 in it.
    // THE CURRENT SIDE'S IS ITS STAGE'S. The console takes its install root from TERM_STDLIB first (decision
    // cli-in-term/006), and from the real deck/base that root is <term>, whose host/<up 4>/zone is the live
    // deck/zone; from its stage's deck/base the root is the stage, as the baseline's is, and both boot the frozen ZONE
    // (decision 018 part 4). The current CLI answers the real path from every resolver, so the link costs it nothing
    // A self-pair (`--current <baseline>/line.js`) keeps the real path on both sides: that binary predates 0067
    TERM_STDLIB: side.stdlib,
    ...row.env,
  }
}

// Both sides of a row run at ONE path, one after the other. A path differing by side is not only text to replace: the
// CLI wraps a long path at the terminal's width, so the two sides broke their lines in different places, and the
// machine-wide caches name their entries by a hash that includes it.
// THE SIGNING KEY is fixed too. With none in HOME, `term host --dry` signs with a throwaway key it makes, so its config
// digest changed every run. Every run's HOME holds this one, made from a fixed seed (an Ed25519 PKCS8 key is a fixed
// prefix and its 32-byte seed), in the shape call/code/host.ts `loadPublishKeypair` reads. It signs nothing real.
function keyText(): string {
  const seed = createHash('sha256').update('verb-pair').digest()
  const privateKey = createPrivateKey({
    key: Buffer.concat([Buffer.from('302e020100300506032b657004220420', 'hex'), seed]),
    format: 'der',
    type: 'pkcs8',
  })

  return JSON.stringify({
    publicKey: createPublicKey(privateKey).export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
  })
}

const KEY = keyText()

function runOne(side: Side, row: Row, base: string): Promise<Run> {
  const root = join(base, String(row.line))
  rmSync(root, { recursive: true, force: true })
  const work = join(root, 'work')
  const home = join(root, 'home')
  // the run's own temporary folder, at the same path on both sides; what is left in it is not compared
  const temp = join(root, 'tmp')
  mkdirSync(temp, { recursive: true })
  mkdirSync(join(home, '.base/@term/code'), { recursive: true })
  writeFileSync(join(home, '.base/@term/code/key'), KEY)

  if (row.fixture === 'empty') {
    mkdirSync(work, { recursive: true })
  } else {
    // the fixture's own times, so a run that reads a file's mtime reads the same one on both sides
    cpSync(join(FIXTURES, row.fixture), work, { recursive: true, preserveTimestamps: true })
  }

  // longest first, and both spellings of macOS's temporary folder (/private/var and /var)
  const replace: [string, string][] = [
    [work, '<work>'],
    [work.replace(/^\/private/, ''), '<work>'],
    [home, '<home>'],
    [home.replace(/^\/private/, ''), '<home>'],
    [root, '<run>'],
    [root.replace(/^\/private/, ''), '<run>'],
    ...side.replace,
  ]

  return new Promise(done => {
    const child = spawn(process.execPath, [side.cli, ...row.args], {
      cwd: work,
      env: environment(home, temp, row, side),
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    })

    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', chunk => (stdout += chunk))
    child.stderr.on('data', chunk => (stderr += chunk))
    // end of input at once: a REPL or a stdin reader sees EOF instead of waiting
    child.stdin.end()

    const timer = setTimeout(() => {
      timedOut = true

      try {
        process.kill(-(child.pid as number), 'SIGKILL')
      } catch {
        child.kill('SIGKILL')
      }
    }, TIMEOUT_MS)

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      const files = new Map<string, string>()
      snapshot(work, 'work', replace, files)
      snapshot(home, 'home', replace, files)
      done({
        exit: timedOut ? 'timeout' : signal ? `signal ${signal}` : String(code),
        stdout: normalize(stdout, replace),
        stderr: normalize(stderr, replace),
        files,
      })
    })
  })
}

// THE MACHINE-WIDE CACHE is compared by what it holds, not by its file names. An entry's name hashes its key, and the
// key holds the toolchain's own identity (where the CLI runs from, and what it is), so two binaries that write the
// same entries name them apart: a self-pair through two stages did exactly that, entry for entry. The project's cache
// (`.base/@term/code/cache/test/<key>.mjs`) is keyed the same way. Each kind of cache (mill, unit, test, ...) becomes
// the sorted list of its entries' contents.
const CACHE = /^(.*\.base\/@term\/code\/(?:base|cache)\/[^/]+)\/(.+)$/
// THE BOOT CACHE (`.base/@term/code/boot/<key>/`, written by a console's boot, the zone rows since
// term-cli-in-term-0227) is the same kind of thing. Its folder's name hashes the toolchain, and its bundles (app.mjs,
// run.mjs, dock.mjs) are what each binary's bundler made, so they read as their names; the emitted units under host/
// are compared whole. inputs.json, the boot's record of what it read (boot.ts and boot-running.tree since c52345ec,
// 2026-10-23 14:26), is written by the current CLI only and is not compared
const BOOT = /^(.*\.base\/@term\/code\/boot)\/[^/]+\/(.+)$/
const BOOT_BUNDLES = ['app.mjs', 'run.mjs', 'dock.mjs']

function filesText(files: Map<string, string>): string {
  const lines: string[] = []
  const cached: string[] = []

  for (const [path, hash] of files) {
    const boot = BOOT.exec(path)

    if (boot) {
      const rest = boot[2] as string

      if (rest !== 'inputs.json') {
        lines.push(`${boot[1] as string}/<key>/${rest} ${BOOT_BUNDLES.includes(rest) ? 'bundled' : hash}`)
      }

      continue
    }

    const found = CACHE.exec(path)

    if (found) {
      const leaf = (found[2] as string).split('/').pop() as string
      // a dot file (`.budget`) is the cache's own, kept by its name
      cached.push(`${found[1] as string}/${leaf.startsWith('.') ? leaf : '<entry>'} ${hash}`)
    } else {
      lines.push(`${path} ${hash}`)
    }
  }

  return [...lines, ...cached.sort()].map(line => `${line}\n`).join('')
}

function slugOf(row: Row): string {
  if (row.name !== undefined) {
    return row.name.replace(/[^a-z0-9 .=-]+/gi, '_')
  }

  return `${String(row.line).padStart(3, '0')}-${row.args.join('-').replace(/[^a-z0-9-]+/gi, '').slice(0, 40)}`
}

async function main(): Promise<void> {
  const only = (flag('only') ?? '').split(',').filter(Boolean)
  const sample = flag('sample') === undefined ? undefined : Number(flag('sample'))
  const seed = Number(flag('seed') ?? 1)
  const jobs = Number(flag('jobs') ?? 4)
  const current = resolve(flag('current') ?? join(TERM, 'host/line.js'))

  if (!existsSync(join(BASELINE, 'line.js'))) {
    throw new Error(`no baseline at ${BASELINE}`)
  }

  // `--current <baseline>/line.js` pairs the baseline with itself: the harness's own determinism check
  vendorYargs()
  stage(WAS, BASELINE, false)
  stage(NOW, dirname(current), true)
  stageZone()
  const baseline = join(WAS, 'host/line.js')
  const wrongYargs = baselineYargs()

  if (wrongYargs !== undefined) {
    console.log(`verb-pair: ${wrongYargs} (decision cli-in-term/015)`)
    console.log('status: FAIL')
    process.exitCode = 1

    return
  }

  const wrongZone = frozenZone()

  if (wrongZone !== undefined) {
    console.log(`verb-pair: ${wrongZone} (decision cli-in-term/018 part 4)`)
    console.log('status: FAIL')
    process.exitCode = 1

    return
  }

  clock()

  const hand = readRows()
  const plan = planRows(hand, readRoutes())

  // a take with no row and no skip stops the pair before anything runs: it is the hole a dropped flag hid in
  if (plan.missing.length > 0) {
    console.log(
      `verb-pair: ${plan.missing.length} takes have no row: add a line to ${FLAGS.slice(REPO.length + 1)}, or 'skip <verb path> --<take> <reason>'`,
    )

    for (const key of plan.missing) {
      console.log(`  ${key}`)
    }

    console.log('status: FAIL')
    process.exitCode = 1

    return
  }

  const all = [...hand, ...plan.rows]
  const verbs = shippedVerbs(baseline)
  const uncovered = verbs.filter(verb => {
    const mine = all.filter(row => row.verb === verb)
    const help = mine.some(row => row.args.includes('--help'))
    const real = mine.some(row => !row.args.includes('--help'))

    return !help || (!real && HELP_ONLY[verb] === undefined)
  })

  // a completion row's verb parses as `term` (`--get-yargs-completions term zone ''`): it also runs with the verb it
  // completes, so `--only zone` runs row 155
  const completes = (row: Row): string | undefined =>
    row.args[0] === '--get-yargs-completions' && row.args[1] === 'term' ? row.args[2] : undefined
  let rows = only.length > 0 ? all.filter(row => only.includes(row.verb) || only.includes(completes(row) ?? '')) : all

  if (sample !== undefined && sample < rows.length) {
    const next = random(seed)
    const order = [...rows]

    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1))
      ;[order[i], order[j]] = [order[j] as Row, order[i] as Row]
    }

    const kept = new Set(order.slice(0, sample))
    rows = rows.filter(row => kept.has(row))
  }

  if (process.argv.includes('--list')) {
    for (const row of rows) {
      console.log(`${row.line} ${row.verb}: ${row.text}${row.name === undefined ? '' : `  [${row.name}]`}`)
    }

    for (const [key, reason] of plan.skipped) {
      console.log(`skip ${key}: ${reason}`)
    }

    console.log(`uncovered: ${uncovered.join(', ') || 'none'}`)

    return
  }

  const base = realpathSync(mkdtempSync(join(tmpdir(), 'verb-pair-')))
  const stages: [string, string][] = [
    [realpathSync(WAS), '<term>'],
    [WAS, '<term>'],
    [realpathSync(NOW), '<term>'],
    [NOW, '<term>'],
    // the stdlib's real path (TERM_STDLIB, environment(), and what every resolver answers since term-compiler-0067),
    // after the stages it is a prefix of
    [TERM, '<term>'],
  ]
  const sides: Side[] = [
    { name: 'baseline', cli: baseline, replace: stages, stdlib: join(TERM, 'deck/base') },
    {
      name: 'current',
      cli: join(NOW, 'host', basename(current)),
      replace: stages,
      stdlib: hashFile(current) === hashFile(join(BASELINE, 'line.js')) ? join(TERM, 'deck/base') : join(NOW, 'deck/base'),
    },
  ]

  // `--show <row line>`: one row's baseline run, normalized, printed whole, to read what a row exercises
  const show = flag('show')

  if (show !== undefined) {
    const row = all.find(one => one.line === Number(show) || one.name === show)

    if (!row) {
      throw new Error(`no row at line ${show} of ${ROWS}`)
    }

    const run = await runOne(sides[0] as Side, row, base)
    rmSync(base, { recursive: true, force: true })
    console.log(`row ${row.line}: ${row.text}\nexit ${run.exit}\n## stdout\n${run.stdout}\n## stderr\n${run.stderr}\n## files\n${filesText(run.files)}`)

    return
  }

  const failures: { row: Row; parts: string[]; dir: string }[] = []
  // disagreements on a DIVERGES row, and DIVERGES rows that read equal
  const explained: { row: Row; parts: string[]; dir: string }[] = []
  const stillEqual: Row[] = []
  let equal = 0
  let next = 0
  mkdirSync(DIFF, { recursive: true })
  const written = new Set<string>()

  const worker = async (): Promise<void> => {
    while (next < rows.length) {
      const row = rows[next++] as Row
      const was = await runOne(sides[0] as Side, row, base)
      const now = await runOne(sides[1] as Side, row, base)
      const parts: string[] = []

      if (was.exit !== now.exit) parts.push(`exit ${was.exit} vs ${now.exit}`)
      if (was.stdout !== now.stdout) parts.push('stdout')
      if (was.stderr !== now.stderr) parts.push('stderr')

      const wasFiles = filesText(was.files)
      const nowFiles = filesText(now.files)

      if (wasFiles !== nowFiles) parts.push('files')

      if (parts.length === 0) {
        equal++

        if (DIVERGES[row.text] !== undefined) {
          stillEqual.push(row)
        }

        continue
      }

      const slug = slugOf(row)
      const dir = join(DIFF, slug)
      mkdirSync(dir, { recursive: true })
      written.add(slug)
      writeFileSync(
        join(dir, 'diff.txt'),
        [
          `row ${row.line}: ${row.text}`,
          `differs: ${parts.join(', ')}`,
          `exit: baseline ${was.exit}, current ${now.exit}`,
          '',
          '## stdout',
          unifiedDiff(was.stdout, now.stdout, 'baseline', 'current'),
          '## stderr',
          unifiedDiff(was.stderr, now.stderr, 'baseline', 'current'),
          '## files',
          unifiedDiff(wasFiles, nowFiles, 'baseline', 'current'),
        ].join('\n'),
      )
      if (DIVERGES[row.text] !== undefined) {
        explained.push({ row, parts, dir })
      } else {
        failures.push({ row, parts, dir })
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, jobs) }, () => worker()))
  rmSync(base, { recursive: true, force: true })

  // an earlier run's diff that this run did not write is marked stale, never removed
  for (const name of readdirSync(DIFF)) {
    if (!written.has(name) && existsSync(join(DIFF, name, 'diff.txt')) && statSync(join(DIFF, name)).isDirectory()) {
      writeFileSync(join(DIFF, name, 'diff.txt'), 'stale\n')
    }
  }

  const pass = failures.length === 0 && uncovered.length === 0
  const lines: string[] = [
    `verb-pair: ${equal} equal, ${failures.length} disagree, ${explained.length} explained`,
    `status: ${pass ? 'PASS' : 'FAIL'}`,
  ]

  for (const one of explained) {
    lines.push(`  diverges row ${one.row.name ?? one.row.line} (${one.row.text}): ${DIVERGES[one.row.text]}`)
  }

  for (const row of stillEqual) {
    lines.push(`  row ${row.line} (${row.text}) is in DIVERGES and reads equal: remove its entry`)
  }

  const byVerb = new Map<string, typeof failures>()

  for (const failure of failures.sort((a, b) => a.row.line - b.row.line)) {
    byVerb.set(failure.row.verb, [...(byVerb.get(failure.row.verb) ?? []), failure])
  }

  if (uncovered.length > 0) {
    lines.push(`uncovered verbs: ${uncovered.join(', ')}`)
  }

  const groups = [...byVerb]
  const room = 14 - lines.length

  for (const [verb, list] of groups.slice(0, room)) {
    const first = list[0] as (typeof failures)[number]
    lines.push(`  ${verb}: ${list.length} disagree (${first.parts.join(', ')}) ${first.dir.slice(REPO.length + 1)}`)
  }

  if (groups.length > room) {
    lines.push(`  ... ${groups.length - room} more verbs under ${DIFF.slice(REPO.length + 1)}`)
  }

  console.log(lines.join('\n'))

  if (!pass) {
    process.exitCode = 1
  }
}

// cli-coverage imports the planning above; only a run of this file pairs
if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void main()
}
