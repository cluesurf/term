// THE INCREMENTAL BENCH (`pnpm term:incremental-bench`, decision 077 section 11 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0405).
//
// How fast the unit build is where a person feels it, on real packages, each scenario three times:
//
//   cold           `term make` in a fresh process on a fresh copy with an empty TERM_CACHE_HOME
//   noop-fresh     `term make` in a fresh process, nothing changed since the last build
//   noop-session   one BuildSession built twice in one process (what a watch keeps), the second build timed
//   body-fresh     a one-line edit inside a body that is neither one statement nor read by anyone, then `term make`
//   body-session   the same edit, built by the session that built the package just before it
//   pure-fresh     a body edit to a pure task three other modules call, then `term make`
//   shape-fresh    a parameter added to a task three other modules call (an interface edit), then `term make`
//   server         the language server opening a document that loads the standard library, then 200 keystrokes
//
// Each records its p50 wall time, the units built and the peak resident memory of the process that ran it (each run is
// its own child process, so a peak is that run's). The edits land in fixture modules this bench adds to its copy of the
// package (code/bench-fixture/), so every corpus has the same shapes to edit, and every edit writes a text never built
// before, so it is a miss every run.
//
// THE GATE: every count equals its prediction (no-op 0, body edit 1, the rest the baseline's count, all three runs
// equal), no p50 is above 1.5 times the baseline's, and no no-op row's peak memory is above 1.1 times the baseline's
// (decision 077 section 11, memory). The in-process rows (noop-session, body-session, server) run the tree's sources
// under tsx and the rest the CLI bundle, so a corpus whose two disagree on the unit store's namespace (a bundle older
// than its sources) has those rows NOT MEASURED and not run, item term-self-host-001-0493. The baseline is incremental-bench.baseline.json beside this file, written by
// `--commit` (and only then). The corpora are @cluesurf/zone, @term/host, @term/base (`--trees`), and @term/test and
// @term/scan on the two rows their bars name (no-op and one-line body edit, fresh process); `--full` adds @term/bind,
// which takes minutes a run. The copies and their caches live under the system temporary directory (the gate's own
// scratch folder under `pnpm term:test`, removed when the suite ends); nothing under deck/ is written.
//
// THE TARGETS (item term-self-host-001-0467): the bars of decision 077 section 11 as decisions 079 and 084 section 3
// amend them, absolute where the decisions write a number (TARGETS below). A relative gate alone let zone's fresh no-op
// pass at 1,460 ms against a 0.3 s bar, and any regression under 50%. Every row with a target prints `target met` or
// `target MISSED` with the load of its runs. A missed target fails the run only under `--targets`, and then only when
// the runs' highest one-minute load is at most TARGET_LOAD: above it the miss is a warning, said so in the row's line,
// since on this machine a load of 20 doubles a fresh process's wall time.
//
//   pnpm term:incremental-bench                      the gate against the baseline
//   pnpm term:incremental-bench --targets            the gate, and every target met (0412's proof)
//   pnpm term:incremental-bench --commit             measure and write the baseline (the first run)
//   pnpm term:incremental-bench --only zone --runs 1 one corpus, one run each (`--only zone,test` for several)
//   --break target | rss                             a deliberate break that must fail the run: every target's bars
//                                                    a thousandth of the decision's (with --targets), or the baseline's
//                                                    peak memory read as 1 MB
//   --target-load <n>                                the load above which a miss only warns (12), for a fail-first run
//   pnpm term:incremental-bench --line <bundle>      another CLI bundle for the fresh-process rows (with TERM_STDLIB
//                                                    set when it lives outside the tree); in-process rows are the tree's
//
// Run from the Term root (the root script does), where host/line.js and the @term/* paths resolve.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import path from 'node:path'
import { gunzipSync } from 'node:zlib'
import { makeScratch, removeTree, scratchEnv, sweepStaleRuns } from './temp-run'
import { CALLER_CWD, PARENT_ROOT, TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
// `--line <path>` measures another CLI bundle (an A/B of a change), host/line.js by default
const LINE_AT = process.argv.indexOf('--line')
const LINE = LINE_AT > 0 ? path.resolve(CALLER_CWD, process.argv[LINE_AT + 1]!) : path.join(TERM, 'host', 'line.js')
const HERE = path.join(REPO, 'task', 'term')
const BASELINE = path.join(HERE, 'incremental-bench.baseline.json')
const FIXTURE = path.join('code', 'bench-fixture')

const ROWS = ['cold', 'noop-fresh', 'noop-session', 'body-fresh', 'body-session', 'pure-fresh', 'shape-fresh', 'server'] as const
type Row = (typeof ROWS)[number]

// `rows`, when given, the only rows a corpus runs: @term/test and @term/scan are measured where their bars are
type Corpus = { name: string; from: string; trees: boolean; full?: boolean; stdlib?: boolean; rows?: Row[] }

const CORPORA: Corpus[] = [
  ...(PARENT_ROOT ? [{ name: 'zone', from: parentPaths('deck/zone')[0]!, trees: false }] : []),
  { name: 'host', from: 'deck/host', trees: false },
  { name: 'base', from: 'deck/base', trees: true, stdlib: true },
  { name: 'test', from: 'deck/test', trees: false, rows: ['noop-fresh', 'body-fresh'] },
  { name: 'scan', from: 'deck/scan', trees: false, rows: ['noop-fresh', 'body-fresh'] },
  { name: 'bind', from: 'deck/bind', trees: false, full: true },
]

// what each row's units built must be, when a rule says so; the rest must equal the baseline's
// pure-fresh is the edited unit and the one caller whose trace holds its shape (pure-user-1's goal), never the two that
// only call it (decision 103 item 7)
const PREDICTED: Partial<Record<Row, number>> = { 'noop-fresh': 0, 'noop-session': 0, 'body-fresh': 1, 'body-session': 1, 'pure-fresh': 2 }

// THE TARGETS, per `<corpus>/<row>` or `*/<row>` for every corpus. `ms` bars the p50 wall time, `times` the p50 against
// the baseline's, `keyP50` and `keyP95` the server's keystrokes, `snapshotKb` the project's graph snapshot after the
// row (the newest file under .base/@term/code/cache/graph/). `from` is the decision that writes the bar.
// Not here, since no number can be read off without a measure this bench does not take: the body edit's "no-op plus
// that unit's own time plus 10%", the interface edit's "summed own times plus 10%", the snapshot's read and write times
// (decision 083 section 7, its own A/B), and the server's memory over 1,000 keystrokes. noop-session's "unchanged or
// faster" is the 1.5 times gate, as in E6.
type Target = { ms?: number; times?: number; keyP50?: number; keyP95?: number; snapshotKb?: number; from: string }

const TARGETS: Record<string, Target> = {
  'zone/noop-fresh': { ms: 300, snapshotKb: 240, from: 'D077 s11 no-op zone; D083 s7 snapshot' },
  'test/noop-fresh': { ms: 1500, from: 'D077 s11 no-op, D079 rule 2' },
  'test/body-fresh': { ms: 1500, from: 'D077 s11 body edit, D079 rule 2, D084 s3' },
  'scan/noop-fresh': { ms: 1500, from: 'D077 s11 no-op, D079 rule 2' },
  'scan/body-fresh': { ms: 1500, from: 'D079 rule 2, D084 s3 (the brief of 0467)' },
  'bind/noop-fresh': { ms: 3000, from: 'D077 s7 and s11 no-op bind' },
  '*/cold': { times: 1.05, from: 'D077 s11 cold build' },
  '*/server': { ms: 150, keyP50: 20, keyP95: 60, from: 'D077 s9 and s11 language server' },
}

// above this one-minute load a missed target is a warning, never a failure (the 0412 proof states the load it ran at).
// `--target-load <n>` moves it, for a fail-first proof on a loaded machine; a proof of the targets keeps 12
const TARGET_LOAD = Number(process.argv[process.argv.indexOf('--target-load') + 1] ?? 12) || 12

// the peak memory gate of a no-op row, against the baseline's (D077 s11 memory, as 0467 bounds the noise)
const RSS_TIMES = 1.1

// `--break target` scales every bar to a thousandth, so each target must read as missed (the gate's own fail-first)
const shrink = (target: Target): Target =>
  Object.fromEntries(Object.entries(target).map(([key, value]) => [key, typeof value === 'number' ? value / 1000 : value])) as Target

const targetOf = (corpus: string, row: Row): Target | undefined => {
  const target = TARGETS[`${corpus}/${row}`] ?? TARGETS[`*/${row}`]

  return target && flag('break') === 'target' ? shrink(target) : target
}

type Run = { ms: number; built: number | null; reused: number | null; rssMb: number; exit: number; load: number; keystroke?: { p50: number; p95: number }; answers?: number }
type Measured = { ms: number; built: number | null; rssMb: number; runs: Run[]; keystroke?: { p50: number; p95: number }; snapshotKb?: number; notMeasured?: boolean }

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)

  return at >= 0 ? args[at + 1] : undefined
}

// ---- the fixture: the shapes every corpus is edited in ----

// a body of two statements nobody reads; a pure task three modules call; a task three modules call whose parameters
// change. Longhand, so a lean role cannot misread them. Each edit point holds a number the bench replaces
const FIXTURE_FILES: Record<string, string> = {
  'leaf.tree': 'task bench-leaf\n  take n, like number\n  like number\n  save a\n    call add\n      read n\n      code 1\n  send back\n    call add\n      read a\n      code 1000\n',
  'pure.tree': 'task bench-pure\n  take n, like number\n  like number\n  send back\n    call add\n      read n\n      code 1000\n',
  'shape.tree': 'task bench-shape\n  take n, like number\n  like number\n  send back, read n\n',
  'server.tree': 'load @term/base/text\n  find trim\n\nload @term/base/list\n  find sort\n\ntask bench-greet\n  take who, like text\n  like text\n  send back\n    call trim\n      text <x {who}>\n\ntask bench-count\n  like number\n  send back, code 1000\n',
}

for (const i of [1, 2, 3]) {
  FIXTURE_FILES[`pure-user-${i}.tree`] = `load ./pure\n  find bench-pure\n\ntask bench-pure-use-${i}\n  like number\n  send back\n    call bench-pure\n      code ${i}\n`
  FIXTURE_FILES[`shape-user-${i}.tree`] = `load ./shape\n  find bench-shape\n\ntask bench-shape-use-${i}\n  like number\n  send back\n    call bench-shape\n      code ${i}\n`
}

// one caller states a goal only the pure task's shape proves, true of every number the bench writes there
FIXTURE_FILES['pure-user-1.tree'] = 'load ./pure\n  find bench-pure\n\ntask bench-pure-use-1\n  like number\n  hold is-above(bench-pure(1), 0)\n  send back\n    call bench-pure\n      code 1\n'

// a number never written before, so an edit is never a stored answer
let stamp = Date.now()
const fresh = (): number => ++stamp

function editNumber(file: string, pattern: RegExp, replace: (n: number) => string): void {
  const text = readFileSync(file, 'utf8')
  const next = text.replace(pattern, replace(fresh()))
  if (next === text) throw new Error(`incremental-bench: no edit point in ${file}`)
  writeFileSync(file, next)
}

const EDITS: Record<string, (root: string) => void> = {
  body: root => editNumber(path.join(root, FIXTURE, 'leaf.tree'), /read a\n {6}code \d+/, n => `read a\n      code ${n}`),
  pure: root => editNumber(path.join(root, FIXTURE, 'pure.tree'), /read n\n {6}code \d+/, n => `read n\n      code ${n}`),
  // a parameter with a default added, its name new every run: every caller's key holds the name, none of them changes
  shape: root => {
    const file = path.join(root, FIXTURE, 'shape.tree')
    const text = readFileSync(file, 'utf8').replace(/ {2}take extra-\d+, like number, fall 0\n/, '')
    writeFileSync(file, text.replace('  like number\n', `  take extra-${fresh()}, like number, fall 0\n  like number\n`))
  },
}

// a copy of the package: its manifest, roles, code and tests, and the fixture. The standard library's copy is built
// AS the standard library (TERM_STDLIB, `stdlibOf`): anywhere else `@term/base/list` reaches the tree's own list.tree
// while `./list` reaches the copy's, and the build refuses both halves. It sits at <dir>/deck/base beside a host/ that
// holds the worker bundles, since the CLI finds host/separate-worker.mjs two folders above TERM_STDLIB
function copyOf(corpus: Corpus, into: string): string {
  const source = path.resolve(REPO, corpus.from)
  const at = corpus.stdlib ? path.join(into, 'deck', 'base') : into

  if (corpus.stdlib) {
    mkdirSync(path.join(into, 'host'), { recursive: true })

    for (const bundle of ['separate-worker.mjs', 'build-worker.mjs']) {
      cpSync(path.join(TERM, 'host', bundle), path.join(into, 'host', bundle))
    }
  }

  mkdirSync(at, { recursive: true })

  for (const part of ['deck.tree', 'role.tree', 'role', 'code', 'test', 'test.tree']) {
    if (existsSync(path.join(source, part))) {
      cpSync(path.join(source, part), path.join(at, part), { recursive: true })
    }
  }

  mkdirSync(path.join(at, FIXTURE), { recursive: true })

  for (const [name, text] of Object.entries(FIXTURE_FILES)) {
    writeFileSync(path.join(at, FIXTURE, name), text)
  }

  return realpathSync(at)
}

const fresher = (prefix: string): string => realpathSync(mkdtempSync(path.join(tmpdir(), `incremental-bench-${prefix}-`)))

// the unit answers a store holds, a refusal and a name pointer apart: with each key built once by one job (decision
// 088), a cold build's built count is exactly this (item term-self-host-001-0477's hunk)
function answersIn(home: string): number {
  const walk = (dir: string, out: string[] = []): string[] => {
    if (!existsSync(dir)) return out
    for (const name of readdirSync(dir)) {
      const at = path.join(dir, name)
      if (statSync(at).isDirectory()) walk(at, out)
      else if (at.endsWith('.json.gz')) out.push(at)
    }
    return out
  }
  let answers = 0
  for (const file of walk(path.join(home, 'unit'))) {
    const text = gunzipSync(readFileSync(file)).toString('utf8')
    if (text.length >= 200 && !text.includes('{\\"diagnostics\\"') && !text.startsWith('{"portable":"trace:')) answers++
  }
  return answers
}

// ---- one run in a child process ----

// the standard library a run reads: the copy itself for the standard library's corpus, the tree's for the rest
const stdlibOf = (corpus: Corpus, root: string): Record<string, string> => (corpus.stdlib ? { TERM_STDLIB: root } : {})

const numberIn = (text: string, pattern: RegExp): number | null => {
  const found = text.match(pattern)

  return found ? Number(found[1]!.replace(/,/g, '')) : null
}

// `term make` in a fresh process, timed from outside, its peak memory from /usr/bin/time
function cliRun(corpus: Corpus, root: string, home: string): Run {
  const started = process.hrtime.bigint()
  const made = spawnSync('/usr/bin/time', ['-l', process.execPath, LINE, 'make', '--no-motion', '--color', 'never', '--plain', ...(corpus.trees ? ['--trees'] : [])], {
    cwd: root,
    env: { ...process.env, TERM_CACHE_HOME: home, ...stdlibOf(corpus, root) },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  const text = `${made.stdout}\n${made.stderr}`
  // the last run's output beside its copy, for a row that fails
  writeFileSync(`${root}-make.log`, text)

  return {
    ms: Math.round(ms),
    built: numberIn(text, /([\d,]+) units? built/),
    reused: numberIn(text, /([\d,]+) reused/),
    rssMb: Math.round((numberIn(text, /(\d+)\s+maximum resident set size/) ?? 0) / 1048576),
    exit: made.status ?? -1,
    load: Number(loadavg()[0].toFixed(1)),
  }
}

// an in-process row, run by this file as a child (`--child`), so its peak memory is its own
function childRun(corpus: Corpus, row: Row, root: string, home: string): Run {
  const ran = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--child', row, root], {
    cwd: TERM,
    env: { ...process.env, TERM_CACHE_HOME: home, ...stdlibOf(corpus, root) },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const line = ran.stdout.split('\n').find(one => one.startsWith('{"child"'))

  if (!line) {
    throw new Error(`incremental-bench: ${row} on ${root} answered nothing\n${ran.stdout.slice(-2000)}\n${ran.stderr.slice(-2000)}`)
  }

  const answer = JSON.parse(line) as { child: true } & Run

  return { ...answer, rssMb: answer.rssMb, load: Number(loadavg()[0].toFixed(1)) }
}

async function child(row: Row, root: string): Promise<void> {
  const { buildSession, compileProjectSeparate } = await import('@term/call/code/make')
  const { projectCache } = await import('@term/call/code/cache-store')
  const rss = (): number => Math.round(process.resourceUsage().maxRSS / 1024)
  const say = (run: Omit<Run, 'load' | 'rssMb' | 'exit'>): void => {
    console.log(JSON.stringify({ child: true, ...run, rssMb: rss(), exit: 0 }))
  }

  if (row === 'server') {
    const { LanguageServer } = await import('@term/flow/code/server')
    const { pathToFileURL } = await import('node:url')
    const file = path.join(root, FIXTURE, 'server.tree')
    const uri = pathToFileURL(file).href
    const textOf = (n: number): string => readFileSync(file, 'utf8').replace(/code \d+\n$/, `code ${n}\n`)
    const server = new LanguageServer({})
    let id = 1
    const dispatch = (message: Record<string, unknown>): Promise<unknown[]> => server.dispatch({ jsonrpc: '2.0', ...message } as never)
    const settle = () => dispatch({ id: id++, method: 'textDocument/diagnostic', params: { textDocument: { uri } } })

    await dispatch({ id: id++, method: 'initialize', params: { capabilities: { textDocument: { diagnostic: {} } } } })
    const opened = performance.now()
    await dispatch({ method: 'textDocument/didOpen', params: { textDocument: { uri, languageId: 'tree', version: 1, text: textOf(0) } } })
    await settle()
    const ms = Math.round(performance.now() - opened)
    const times: number[] = []

    for (let n = 1; n <= 200; n++) {
      const started = performance.now()
      await dispatch({ method: 'textDocument/didChange', params: { textDocument: { uri, version: n + 1 }, contentChanges: [{ text: textOf(n) }] } })
      await settle()
      times.push(performance.now() - started)
    }

    const sorted = [...times].sort((a, b) => a - b)
    const at = (q: number): number => Number(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!.toFixed(1))
    say({ ms, built: null, reused: null, keystroke: { p50: at(0.5), p95: at(0.95) } })

    return
  }

  const session = buildSession(root)
  const cache = projectCache(root)
  // the build the session keeps, untimed, then the one measured
  compileProjectSeparate(root, cache, 'node', session)

  if (row === 'body-session') {
    EDITS.body!(root)
  }

  const started = performance.now()
  const built = compileProjectSeparate(root, cache, 'node', session)
  say({ ms: Math.round(performance.now() - started), built: built.built, reused: built.reused })
}

// the unit store namespace the TREE'S SOURCES key by, as the in-process rows run them under tsx (`--child version`)
async function sourcesVersion(): Promise<void> {
  const { compilerVersion, versionSlug } = await import('@term/call/code/cache-store')
  console.log(JSON.stringify({ child: true, slug: versionSlug(compilerVersion('unit')) }))
}

function sourcesSlug(corpus: Corpus, root: string, home: string): string {
  const ran = spawnSync(process.execPath, [...process.execArgv, process.argv[1]!, '--child', 'version', root], {
    cwd: TERM,
    env: { ...process.env, TERM_CACHE_HOME: home, ...stdlibOf(corpus, root) },
    encoding: 'utf8',
  })
  const line = ran.stdout.split('\n').find(one => one.startsWith('{"child"'))

  if (!line) throw new Error(`incremental-bench: the sources' version answered nothing\n${ran.stderr.slice(-2000)}`)

  return (JSON.parse(line) as { slug: string }).slug
}

// the rows run in this file's own tsx child, on the tree's TypeScript sources, where the rest run the CLI bundle
const IN_PROCESS: Row[] = ['noop-session', 'body-session', 'server']

// ---- the bench ----

const p50 =(values: number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!

// the unit store's namespaces under a cache home, one per compiler version (compile-store.tree `compiler-version`)
function namespacesOf(home: string): string[] {
  const unit = path.join(home, 'unit')

  return existsSync(unit) ? readdirSync(unit).filter(name => statSync(path.join(unit, name)).isDirectory()) : []
}

// the project's graph snapshot after a build (build-graph.tree `snapshot-path`, one file per compiler): the newest, in
// KB, or undefined where the build wrote none
function snapshotKbOf(root: string): number | undefined {
  const folder = path.join(root, '.base', '@term', 'code', 'cache', 'graph')

  if (!existsSync(folder)) return undefined

  const files = readdirSync(folder)
    .map(name => statSync(path.join(folder, name)))
    .filter(stat => stat.isFile())
    .sort((a, b) => b.mtimeMs - a.mtimeMs)

  return files.length === 0 ? undefined : Math.round(files[0]!.size / 1024)
}

// what a row's measure misses of its target, each as a short phrase; empty when every bar is met. A bar that needs a
// measure the row lacks (no baseline for `times`, no snapshot) is a miss, never a pass by absence
function targetMisses(target: Target, one: Measured, was: Measured | undefined): string[] {
  const out: string[] = []

  if (target.ms !== undefined && one.ms > target.ms) out.push(`p50 ${one.ms} ms above ${target.ms} ms`)
  if (target.times !== undefined) {
    if (!was) out.push(`no baseline to hold ${target.times} times against`)
    else if (one.ms > target.times * was.ms) out.push(`p50 ${one.ms} ms above ${target.times} times the baseline's ${was.ms} ms`)
  }
  if (target.keyP50 !== undefined && (one.keystroke?.p50 ?? Infinity) > target.keyP50) out.push(`keystroke p50 ${one.keystroke?.p50 ?? 'none'} ms above ${target.keyP50} ms`)
  if (target.keyP95 !== undefined && (one.keystroke?.p95 ?? Infinity) > target.keyP95) out.push(`keystroke p95 ${one.keystroke?.p95 ?? 'none'} ms above ${target.keyP95} ms`)
  if (target.snapshotKb !== undefined && (one.snapshotKb ?? Infinity) > target.snapshotKb) out.push(`snapshot ${one.snapshotKb ?? 'none'} KB above ${target.snapshotKb} KB`)

  return out
}

const targetText = (target: Target): string =>
  [
    target.ms !== undefined ? `p50 <= ${target.ms} ms` : '',
    target.times !== undefined ? `p50 <= ${target.times}x baseline` : '',
    target.keyP50 !== undefined ? `key p50 <= ${target.keyP50} ms` : '',
    target.keyP95 !== undefined ? `key p95 <= ${target.keyP95} ms` : '',
    target.snapshotKb !== undefined ? `snapshot <= ${target.snapshotKb} KB` : '',
  ]
    .filter(Boolean)
    .join(', ')

const measuredText = (target: Target, one: Measured, was: Measured | undefined): string =>
  [
    `p50 ${one.ms} ms${target.times !== undefined && was ? ` (baseline ${was.ms})` : ''}`,
    one.keystroke && (target.keyP50 !== undefined || target.keyP95 !== undefined) ? `key ${one.keystroke.p50}/${one.keystroke.p95} ms` : '',
    target.snapshotKb !== undefined ? `snapshot ${one.snapshotKb ?? 'none'} KB` : '',
  ]
    .filter(Boolean)
    .join(', ')

// Every copy and home of a run sits in one scratch folder (temp-run.ts), removed when the run ends and swept by the next
// run if this one is killed: incremental-bench-*-warm and -cold folders of 1.3 GB each were left in the system temp
// folder (item term-self-host-001-0539). `--keep-temp` keeps them to look at a run. Children inherit TMPDIR
const openScratch = (): void => {
  sweepStaleRuns()
  const scratch = makeScratch('tp')

  Object.assign(process.env, scratchEnv(scratch))

  process.on('exit', () => {
    if (process.argv.includes('--keep-temp')) console.error(`kept: ${scratch}`)
    else removeTree(scratch)
  })
}

async function bench(): Promise<void> {
  openScratch()
  const full = args.includes('--full')
  const only = flag('only')
  const runs = Number(flag('runs') ?? 3)
  const commit = args.includes('--commit')
  const gateTargets = args.includes('--targets')
  if (commit && flag('break') !== undefined) throw new Error('incremental-bench: --break never writes a baseline')
  const baseline = existsSync(BASELINE) ? (JSON.parse(readFileSync(BASELINE, 'utf8')) as { rows: Record<string, Measured> }) : undefined
  const onlyNames = only?.split(',')
  const corpora = CORPORA.filter(corpus => (onlyNames ? onlyNames.includes(corpus.name) : full || !corpus.full))
  const measured: Record<string, Measured> = {}
  const failures: string[] = []
  // every target's verdict, printed together at the end: met, missed (failing), or missed under load (a warning)
  const verdicts: string[] = []

  console.log(`incremental-bench: ${corpora.map(c => c.name).join(', ')}, ${runs} runs a row, ${cpus().length} cores, load ${loadavg()[0].toFixed(1)}${gateTargets ? `, targets gated at load ${TARGET_LOAD} or less` : ''}`)

  for (const corpus of corpora) {
    // the warm copy, built once untimed, which every row but cold and server runs on in turn
    const warm = copyOf(corpus, fresher(`${corpus.name}-warm`))
    const home = fresher(`${corpus.name}-home`)
    const first = cliRun(corpus, warm, home)

    if (first.exit !== 0 && first.built === null) {
      failures.push(`${corpus.name}: the first build failed (exit ${first.exit})`)
      continue
    }

    // THE COMPILER MUST HOLD STILL. The store's namespace is the compiler's version, a hash of its sources' paths, sizes
    // and modification times (work/cache/compile-store.tree compiler-source-hash), so a port-build or make:line of
    // another session, or an edit to a compiler .ts, while a row runs moves every unit to a new namespace and the next
    // build rebuilds them all: zone's fresh no-op read 93 built and 11,995 ms that way (item term-self-host-001-0478).
    // A run that leaves a namespace the corpus has not seen is NOT MEASURED, and its row fails saying so. A proof of the
    // targets runs under the line lock (task/term/line-lock.ts run), which holds every port-build and make:line off
    const known = new Set(namespacesOf(home))
    const moved = (at: string): string[] => {
      const fresh = namespacesOf(at).filter(space => !known.has(space))
      for (const space of fresh) known.add(space)
      return fresh
    }

    // ONE COMPILER FOR EVERY ROW. The in-process rows run the tree's sources under tsx, the rest the bundle, and the
    // store's namespace is each one's own compiler version. A bundle older than the sources it was made from (a
    // CACHE_EPOCH bump or a regenerated cache-scope.generated.ts before the next make:line) keys a namespace the
    // sources do not: noop-session then builds every unit again into a new namespace (NOT MEASURED above), body-session
    // stores its edit where the next fresh build never looks, and pure-fresh's first run rebuilds that edited leaf.tree
    // too, 5, 4, 4 against a prediction of 4 (item term-self-host-001-0493). The in-process rows are not run when the
    // two disagree, so every fresh row still measures one compiler
    const sources = corpus.rows && !corpus.rows.some(row => IN_PROCESS.includes(row)) ? undefined : sourcesSlug(corpus, warm, home)
    const split = sources !== undefined && !known.has(sources)

    for (const row of ROWS.filter(one => !corpus.rows || corpus.rows.includes(one))) {
      if (split && IN_PROCESS.includes(row)) {
        const key = `${corpus.name}/${row}`
        const reason = `not measured: the sources (unit namespace ${sources!.slice(0, 8)}) and the CLI bundle (${[...known].map(space => space.slice(0, 8)).join(', ')}) are two compilers, run make:line`
        verdicts.push(`  ${key.padEnd(20)} NOT MEASURED  the sources and the CLI bundle are two compilers`)
        console.log(`  ${key.padEnd(20)} FAIL ${reason}`)
        failures.push(`${key}: ${reason}`)
        continue
      }

      const done: Run[] = []
      // the namespaces a run of this row left that the corpus had not seen
      const movedTo: string[] = []

      for (let i = 0; i < runs; i++) {
        let run: Run

        switch (row) {
          case 'cold': {
            const coldHome = fresher(`${corpus.name}-cold-home`)
            run = cliRun(corpus, copyOf(corpus, fresher(`${corpus.name}-cold`)), coldHome)
            run = { ...run, answers: answersIn(coldHome) }
            movedTo.push(...moved(coldHome))
            break
          }
          case 'noop-fresh':
            run = cliRun(corpus, warm, home)
            break
          case 'body-fresh':
          case 'pure-fresh':
          case 'shape-fresh':
            EDITS[row.replace('-fresh', '')]!(warm)
            run = cliRun(corpus, warm, home)
            break
          default:
            run = childRun(corpus, row, warm, home)
        }

        if (row !== 'cold') movedTo.push(...moved(home))
        done.push(run)
      }

      const key = `${corpus.name}/${row}`
      const one: Measured = {
        ms: p50(done.map(run => run.ms)),
        built: done[0]!.built,
        rssMb: p50(done.map(run => run.rssMb)),
        runs: done,
        ...(done[0]!.keystroke ? { keystroke: { p50: p50(done.map(run => run.keystroke!.p50)), p95: p50(done.map(run => run.keystroke!.p95)) } } : {}),
        ...(row === 'noop-fresh' ? { snapshotKb: snapshotKbOf(warm) } : {}),
      }
      measured[key] = one

      // the gate: counts exact and equal across runs, time within 1.5 times the baseline
      const counts = done.map(run => run.built)
      const kept = baseline?.rows[key]
      // `--break rss`: the baseline's peak memory read as 1 MB, so every no-op row's memory gate must fail
      const was = kept && flag('break') === 'rss' ? { ...kept, rssMb: 1 } : kept
      const predicted = PREDICTED[row] ?? was?.built ?? counts[0]
      const said: string[] = []

      // a cold build builds each unit key once (decision 088, item 0477): its count equals the distinct answers it stored
      // and is the same on every run. The server row's count is reported, never gated
      const exact = row !== 'server'
      if (row === 'cold') for (const run of done) if (run.answers !== undefined && run.built !== run.answers) said.push(`built ${run.built}, distinct answers stored ${run.answers}`)

      // a row whose compiler moved under it measured another compiler's first build: no count or time of it means
      // anything, so it fails on that alone, and its target is not judged
      if (movedTo.length > 0) {
        const reason = `not measured: the compiler moved during the row (store namespace ${movedTo.map(space => space.slice(0, 8)).join(', ')} new), run under the line lock`
        measured[key] = { ...one, notMeasured: true }
        verdicts.push(`  ${key.padEnd(20)} NOT MEASURED  the compiler moved during the row  loads ${done.map(run => run.load).join(' ')}`)
        console.log(`  ${key.padEnd(20)} p50 ${String(one.ms).padStart(7)} ms  built ${counts.join('/').padStart(5)}  loads ${done.map(run => run.load).join(' ')}  FAIL ${reason}`)
        failures.push(`${key}: ${reason}`)
        continue
      }

      if (exact && counts.some(count => count !== counts[0])) said.push(`counts differ across runs: ${counts.join(', ')}`)
      if (exact && counts[0] !== predicted) said.push(`built ${counts[0]}, predicted ${predicted}`)
      if (done.some(run => run.exit !== 0)) said.push(`exit ${done.map(run => run.exit).join(', ')}`)
      if (was && one.ms > 1.5 * was.ms) said.push(`p50 ${one.ms} ms above 1.5 times the baseline's ${was.ms} ms`)
      if (was?.keystroke && one.keystroke && one.keystroke.p50 > 1.5 * was.keystroke.p50) said.push(`keystroke p50 ${one.keystroke.p50} ms above 1.5 times the baseline's ${was.keystroke.p50} ms`)
      // a no-op's peak memory, always gated (memory does not move with the load as time does)
      if ((row === 'noop-fresh' || row === 'noop-session') && was && was.rssMb > 0 && one.rssMb > RSS_TIMES * was.rssMb) said.push(`peak rss ${one.rssMb} MB above ${RSS_TIMES} times the baseline's ${was.rssMb} MB`)

      // the target, when a decision writes one for this row
      const target = targetOf(corpus.name, row)
      const peak = Math.max(...done.map(run => run.load))
      let verdict = ''

      if (target) {
        const missed = targetMisses(target, one, was)
        const under = peak <= TARGET_LOAD
        verdict = missed.length === 0 ? 'target met' : `target MISSED (${missed.join('; ')})${gateTargets && !under ? `, a warning: load ${peak} is above ${TARGET_LOAD}` : ''}`
        verdicts.push(`  ${key.padEnd(20)} ${missed.length === 0 ? 'met   ' : gateTargets && !under ? 'warn  ' : 'MISSED'}  ${targetText(target)}  measured ${measuredText(target, one, was)}  loads ${done.map(run => run.load).join(' ')}  [${target.from}]`)
        if (missed.length > 0 && gateTargets && under) said.push(`target missed: ${missed.join('; ')}`)
      }

      const keys = one.keystroke ? `, keystroke p50 ${one.keystroke.p50} ms p95 ${one.keystroke.p95} ms` : ''
      const snap = one.snapshotKb !== undefined ? `, snapshot ${one.snapshotKb} KB` : ''
      console.log(`  ${key.padEnd(20)} p50 ${String(one.ms).padStart(7)} ms  built ${(new Set(counts).size > 1 ? counts.join('/') : String(one.built ?? '-')).padStart(5)}  rss ${String(one.rssMb).padStart(5)} MB${keys}${snap}  loads ${done.map(run => run.load).join(' ')}${verdict ? `  ${verdict}` : ''}${said.length > 0 ? `  FAIL ${said.join('; ')}` : ''}`)
      failures.push(...said.map(one => `${key}: ${one}`))
    }
  }

  if (commit) {
    // a row the compiler moved under is never a baseline
    const kept = Object.fromEntries(Object.entries(measured).filter(([, one]) => !one.notMeasured))
    const merged = { taken: new Date().toISOString(), cores: cpus().length, rows: { ...(baseline?.rows ?? {}), ...kept } }
    writeFileSync(BASELINE, `${JSON.stringify(merged, null, 2)}\n`)
    console.log(`incremental-bench: baseline written, ${BASELINE}`)
  } else if (!baseline) {
    console.log('incremental-bench: no baseline yet; --commit writes this run as the baseline')
  }

  if (verdicts.length > 0) {
    console.log(`\nincremental-bench: targets (${gateTargets ? `gated, a miss fails at load ${TARGET_LOAD} or less and warns above` : 'reported; --targets gates them'})`)
    for (const line of verdicts) console.log(line)
  }

  // the gate's summary line (task/term/test.ts)
  const total = Object.keys(measured).length
  console.log(`\nincremental-bench: ${total - new Set(failures.map(one => one.split(':')[0])).size} pass, ${new Set(failures.map(one => one.split(':')[0])).size} fail`)
  process.exit(failures.length === 0 ? 0 : 1)
}

// no top-level await: task/term runs as CommonJS under tsx
void (args[0] === '--child' ? (args[1] === 'version' ? sourcesVersion() : child(args[1] as Row, args[2]!)) : bench()).catch(problem => {
  console.error(problem)
  process.exit(2)
})
