// The logic-shim benchmark (decision 132 points 2 and 3 of term/self-host/change/001, item term-self-host-001-1062):
// a runtime shim's ops against the Term module that replaces it, in ONE emitted program, cases checked before they are
// timed. From item 0723's tmp benchmark (gen.mjs, table.mjs, m3-sweep.sh), made permanent.
//
//   tsx task/term/shim-bench.ts --env <node|browser|rust|swift|kotlin> --shim <name>
//                                       build, check every case, time best of 7, write the baseline
//   ... --check                         the same run, writes nothing: exit 1 on a differ, or on a kept op that now reads
//                                       within 1.2 (it ports)
//   ... --candidate <file>              time this .tree instead of the spec's candidate (a draft not landed yet)
//   ... --work <dir>                    the generated program, its cases and logs (default tmp/shim-bench/<env>-<shim>)
//   ... --build-only                    generate and build, print the program and its cases file, run nothing
//   ... --log <file> [--log <file>]     read the run from these logs (the second is the re-run) instead of running:
//                                       the program was built with --build-only and run elsewhere
//   ... --baseline <file>               where the baseline goes (default task/term/shim-bench/<env>/<shim>.baseline.json)
//
// The spec of each shim is task/term/shim-bench/<env>/<shim>.json: the shim's global, the candidate .tree (relative to
// the Term root), the rounds a trial makes, and per op the shim's op, the candidate's task, the arity, the result kind
// and the case generator. The cases are generated here from a seeded mulberry32 (seeded by the shim's global), 2048 an
// op, the same cases 0723 measured, and written beside the program: the program reads them from the file
// TERM_SHIM_BENCH_CASES names, so a built program runs anywhere.
//
// The rule (decision 132 point 2): per op, the gross ratio Term over shim. An op over 1.2 is run once more and is kept
// only when both runs read over 1.2. Any differ keeps the op. Run it on the benchmark machine at a load under 12: a
// gross ratio within 1.15 reads as equal (finding/logic-shims.md).
//
// The env seam: node runs the program under node. browser runs it on node's V8 too, with the candidate's `case browser`
// read as `case node` and the browser shim found first (a copy of native/browser/runtime/<shim>.ts at
// <work>/runtime/node/, the folder the runtime prelude tries before the stdlib's). rust, swift and kotlin are the next
// item's (term-self-host-001-1063): each needs its own emit, build and run, and the program shape stays.
//
// Run from the Term root.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TERM_ROOT } from './root'

const HERE = dirname(fileURLToPath(import.meta.url))
const SPECS = join(HERE, 'shim-bench')
const TRIALS = 7
const SIZE = 2048
const RULE = 1.2
const CASES_VARIABLE = 'TERM_SHIM_BENCH_CASES'

type Kind = 'number' | 'boolean' | 'text' | 'dynamic'
type Op = { op: string; shim_op: string; term_op: string; arity: number; kind: Kind; cases: string }
type Spec = { shim: string; candidate: string; rounds: number; ops: Op[] }

type Row = {
  op: string
  shim_ns: number
  term_ns: number
  loop_ns: number
  gross_ratio: number
  net_ratio: number | null
  cases: number
  equal: number
  differ: number
  past_safe_range: number
  rerun_gross_ratio: number | null
  state: 'ported' | 'kept'
}

// ---- arguments ----

const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : undefined
}
const flags = (name: string): string[] => argv.flatMap((word, at) => (word === name && argv[at + 1] ? [argv[at + 1]!] : []))
const fail = (message: string): never => {
  console.error(`shim-bench: ${message}`)
  process.exit(2)
}

const envName = flag('--env') ?? fail('--env <node|browser|rust|swift|kotlin> is required')
const shimName = flag('--shim') ?? fail('--shim <name> is required')
const CHECK = argv.includes('--check')
const BUILD_ONLY = argv.includes('--build-only')
// every path a flag names is relative to the Term root, the folder this runs from
const LOGS = flags('--log').map(file => resolve(TERM_ROOT, file))

// ---- the cases: 0723's generators, call for call, so the cases are the ones it measured ----

let seed = 7
function random(): number {
  seed = (seed + 0x6d2b79f5) | 0
  let t = seed
  t = Math.imul(t ^ (t >>> 15), t | 1)
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296
}
const pick = <T>(list: T[]): T => list[Math.floor(random() * list.length)]!
const int = (low: number, high: number): number => low + Math.floor(random() * (high - low + 1))

function bitValue(): number {
  switch (int(0, 5)) {
    case 0: return int(-256, 256)
    case 1: return int(-2147483648, 2147483647)
    case 2: return int(2147483648, 4294967295)
    case 3: return int(-9007199254740991, 9007199254740991)
    case 4: return int(0, 9007199254740991)
    default: return pick([0, -1, 1, 2147483647, -2147483648, 4294967295, 4294967296, 9007199254740991, -9007199254740991])
  }
}
// the hash-loop shape: both sides in the signed or unsigned 32-bit range, where the shim takes the host operator
const word = (): number => (random() < 0.5 ? int(-2147483648, 2147483647) : int(0, 4294967295))

function scalar(): unknown {
  return pick<unknown>([0, 1, -1, 2.5, 1e21, 'a', '', 'text', '😀', '𝔸', true, false, null, int(-1000, 1000), 'k' + int(0, 9)])
}
function value(depth: number): unknown {
  const roll = random()
  if (depth > 3 || roll < 0.5) return scalar()
  if (roll < 0.9) return Array.from({ length: int(0, 4) }, () => value(depth + 1))
  return { k: value(depth + 1) }
}
const hasRecord = (v: unknown): boolean => (Array.isArray(v) ? v.some(hasRecord) : v !== null && typeof v === 'object')
const copy = (v: unknown): unknown => JSON.parse(JSON.stringify(v))
const numberish = (): unknown => (random() < 0.8 ? int(-1000, 1000) + pick([0, 0.5, 0.25]) : scalar())
function jsonValue(): unknown {
  return pick<unknown>([{ a: 1, b: 'x', c: [1, 2] }, { k: null }, [1, 'two', null, true], 'text', 3.5, true, null, [], {}])
}
function code(): number {
  switch (int(0, 5)) {
    case 0: return int(0, 127)
    case 1: return int(128, 0x2ff)
    case 2: return int(0x370, 0x52f)
    case 3: return int(0x4e00, 0x9fff)
    case 4: return int(0x10000, 0x10ffff)
    default: return pick([0, 9, 10, 32, 0xa0, 0x1680, 0x2028, 0x3000, 0xdf, 0x130, 0x1e9e, 0xd800, 0xdfff, 0xfb00])
  }
}
const segments = ['', 'a', 'b.c', '..', '.', 'dir', '.hidden', 'file.tar.gz', 'x.', '😀.𝔸', ' ']
function pathText(): string {
  const parts = Array.from({ length: int(0, 4) }, () => pick(segments))
  const lead = random() < 0.4 ? '/' : ''
  const tail = random() < 0.2 ? '/' : ''
  return lead + parts.join('/') + tail
}

// each case is its arguments, then 'plain' or 'record' (a case holding a record, counted apart when it differs)
const many = (n: number, make: () => unknown[]): unknown[][] => Array.from({ length: n }, make)
const GENERATORS: Record<string, (n: number) => unknown[][]> = {
  'bit-pairs': n => many(n, () => [bitValue(), bitValue(), 'plain']),
  'bit-shifts': n => many(n, () => [bitValue(), random() < 0.7 ? int(0, 31) : int(32, 63), 'plain']),
  'bit-singles': n => many(n, () => [bitValue(), 'plain']),
  'word-pairs': n => many(n, () => [word(), word(), 'plain']),
  'word-shifts': n => many(n, () => [word(), int(0, 31), 'plain']),
  'word-singles': n => many(n, () => [int(-2147483648, 2147483647), 'plain']),
  // an equal pair half the time, so the deep walk is reached and not only the first difference
  'compare-pairs': n =>
    many(n, () => {
      const a = value(0)
      const b = random() < 0.5 ? copy(a) : value(0)
      return [a, b, hasRecord(a) || hasRecord(b) ? 'record' : 'plain']
    }),
  'contains-pairs': n =>
    many(n, () => {
      const list = random() < 0.9 ? Array.from({ length: int(0, 8) }, () => value(2)) : scalar()
      const item = Array.isArray(list) && list.length > 0 && random() < 0.5 ? copy(pick(list)) : value(2)
      return [list, item, hasRecord(list) || hasRecord(item) ? 'record' : 'plain']
    }),
  'number-pairs': n => many(n, () => [numberish(), numberish(), 'plain']),
  'any-singles': n => many(n, () => [value(1), 'plain']),
  'field-pairs': n => many(n, () => [jsonValue(), pick(['a', 'b', 'c', 'k', 'missing', 'toString']), 'plain']),
  'item-pairs': n => many(n, () => [jsonValue(), int(-1, 4), 'plain']),
  'json-singles': n => many(n, () => [jsonValue(), 'plain']),
  codes: n => many(n, () => [code(), 'plain']),
  'path-singles': n => many(n, () => [pathText(), 'plain']),
  'path-pairs': n => many(n, () => [pathText(), pathText(), 'plain']),
}

// the cases depend only on the shim's global, so two candidates for one shim meet the same cases
function makeCases(spec: Spec): unknown[][][] {
  seed = 7
  for (const ch of spec.shim) seed = (Math.imul(seed, 31) + ch.charCodeAt(0)) | 0
  return spec.ops.map(op => (GENERATORS[op.cases] ?? fail(`${op.op}: no case generator '${op.cases}'`))(SIZE))
}

// ---- the program ----

const shimAlias = (spec: Spec): string => (spec.shim === 'compare' ? 'compare-runtime' : 'shim')
const callArgs = (arity: number): string => Array.from({ length: arity }, (_, k) => `c/${k}`).join(', ')

// keeps a result alive at the same cost on both sides
function sink(kind: Kind): string[] {
  switch (kind) {
    case 'number': return ['fork test, is-below(out, 0)', '  hold', '    save sink, add(sink, 1)']
    case 'boolean': return ['fork test, out', '  hold', '    save sink, add(sink, 1)']
    case 'text': return ['save sink, add(sink, out/length)']
    default: return ['fork test, probe/is-null(out)', '  hold', '    save sink, add(sink, 1)']
  }
}

const same = (kind: Kind): string =>
  kind === 'number' ? 'or(is-equal(got, want), and(is-unequal(got, got), is-unequal(want, want)))' : 'is-equal(got, want)'

function timer(task: string, call: string, kind: Kind): string {
  return [
    `task ${task}`,
    '  take cases, like list, like dynamic',
    '  take rounds, like number',
    '  like number',
    '',
    '  save sink, 0',
    '  save start, read-nanoseconds()',
    '  save r, 0',
    '  walk test',
    '    hook test, is-below(r, rounds)',
    '    hook hold',
    '      save i, 0',
    '      walk test',
    '        hook test, is-below(i, cases/length)',
    '        hook hold',
    '          save c, get(cases, i)',
    `          save out, as-any(${call})`,
    ...sink(kind).map(line => `          ${line}`),
    '          save i, add(i, 1)',
    '      save r, add(r, 1)',
    '  save took, subtract(read-nanoseconds(), start)',
    '  fork test, is-equal(sink, -1)',
    '    hold',
    '      log(<sink>)',
    '  back took',
    '',
  ].join('\n')
}

function program(spec: Spec, label: string, load: string): string {
  const alias = shimAlias(spec)
  const out: string[] = [
    `# Generated by task/term/shim-bench.ts: the ${label} shim against its Term candidate, ${SIZE} cases an op, best of`,
    `# ${TRIALS} trials, in picoseconds a call. Do not edit.`,
    '',
    'load @term/base/console\n  find log\n',
    'load @term/base/clock\n  find read-nanoseconds\n',
    'load @term/base/list\n  find get\n  find push\n',
    'load @term/base/file\n  find read, name read-cases\n',
    'load @term/base/environment\n  find variable, name read-variable\n',
    'dock load\n  load <global:json>, name cases-json\n',
    'dock load\n  load <global:shape>, name probe\n',
    // the compare shim calls itself through the alias every caller docks it as, compare-runtime (trap T-0723a)
    `dock load\n  load <global:${spec.shim}>, name ${alias}\n`,
    `load ${load}`,
    ...[...new Set(spec.ops.map(op => op.term_op))].map(found => `  find ${found}`),
    '',
    // every timed result is read as the host's any, so the sink costs the same whatever type the call declares
    'task as-any\n  take value, like dynamic\n  like dynamic\n\n  back value\n',
    // the safe range, outside which a host number is inexact and Term stops
    'task is-unsafe\n  take value, like dynamic\n  like boolean\n\n  back or(is-above(value, 9007199254740991), is-below(value, -9007199254740991))\n',
  ]
  for (const { op, shim_op, term_op, arity, kind } of spec.ops) {
    const shimCall = `${alias}/${shim_op}(${callArgs(arity)})`
    const termCall = `${term_op}(${callArgs(arity)})`
    out.push(
      [
        '# every case once: the agreeing ones are kept for timing',
        `task check-${op}`,
        '  take cases, like dynamic',
        '  take kept, like list, like dynamic',
        '  like text',
        '',
        '  save equal, 0',
        '  save plain, 0',
        '  save record, 0',
        '  save unsafe, 0',
        '  save shown, 0',
        '  save i, 0',
        '  walk test',
        '    hook test, is-below(i, cases/length)',
        '    hook hold',
        '      save c, cases/{i}',
        `      save want, ${shimCall}`,
        ...(kind === 'number'
          ? ['      fork test, is-unsafe(want)', '        hold', '          save unsafe, add(unsafe, 1)', '          save i, add(i, 1)', '          turn next']
          : []),
        `      save got, ${termCall}`,
        `      fork test, ${same(kind)}`,
        '        hold',
        '          save equal, add(equal, 1)',
        '          push(kept, c)',
        '        miss',
        `          fork test, is-equal(c/${arity}, <record>)`,
        '            hold',
        '              save record, add(record, 1)',
        '            miss',
        '              save plain, add(plain, 1)',
        '          fork test, is-below(shown, 4)',
        '            hold',
        `              log(<  differ ${op} {cases-json/stringify(c)} shim {cases-json/stringify(want)} term {cases-json/stringify(got)}>)`,
        '              save shown, add(shown, 1)',
        '      save i, add(i, 1)',
        '  back <cases {cases/length} equal {equal} disagree {plain} disagree-record {record} unsafe-answer {unsafe}>',
        '',
      ].join('\n'),
    )
    out.push(timer(`time-shim-${op}`, shimCall, kind))
    out.push(timer(`time-term-${op}`, termCall, kind))
    out.push(timer(`time-base-${op}`, 'c/0', 'dynamic'))
  }
  // best of the trials, shim and Term taking turns to go first
  out.push(
    [
      'task best',
      '  take a, like number',
      '  take b, like number',
      '  like number',
      '',
      '  fork test, or(is-below(a, 0), is-below(b, a))',
      '    hold',
      '      back b',
      '  back a',
      '',
      'task per-call',
      '  take took, like number',
      '  take calls, like number',
      '  like number',
      '',
      '  fork test, is-equal(calls, 0)',
      '    hold',
      '      back 0',
      '  back divide(multiply(took, 1000), calls)',
      '',
    ].join('\n'),
  )
  const run = [
    'task run',
    '  mark async',
    '',
    `  log(<shim ${label} rounds ${spec.rounds} trials ${TRIALS}>)`,
    `  save all, cases-json/parse(read-cases(read-variable(<${CASES_VARIABLE}>)))`,
  ]
  spec.ops.forEach(({ op }, index) => {
    run.push(
      `  save cases-${op}, all/${index}`,
      `  save kept-${op}, make list`,
      `  save verdict-${op}, check-${op}(cases-${op}, kept-${op})`,
      `  save shim-${op}, -1`,
      `  save term-${op}, -1`,
      `  save base-${op}, -1`,
      `  save trial-${op}, 0`,
      '  walk test',
      `    hook test, is-below(trial-${op}, ${TRIALS})`,
      '    hook hold',
      `      fork test, is-equal(modulo(trial-${op}, 2), 0)`,
      '        hold',
      `          save shim-${op}, best(shim-${op}, time-shim-${op}(kept-${op}, ${spec.rounds}))`,
      `          save term-${op}, best(term-${op}, time-term-${op}(kept-${op}, ${spec.rounds}))`,
      '        miss',
      `          save term-${op}, best(term-${op}, time-term-${op}(kept-${op}, ${spec.rounds}))`,
      `          save shim-${op}, best(shim-${op}, time-shim-${op}(kept-${op}, ${spec.rounds}))`,
      `      save base-${op}, best(base-${op}, time-base-${op}(kept-${op}, ${spec.rounds}))`,
      `      save trial-${op}, add(trial-${op}, 1)`,
      `  save calls-${op}, multiply(kept-${op}/length, ${spec.rounds})`,
      `  log(<op ${spec.shim}/${op} shim-ps {per-call(shim-${op}, calls-${op})} term-ps {per-call(term-${op}, calls-${op})} base-ps {per-call(base-${op}, calls-${op})} {verdict-${op}}>)`,
    )
  })
  out.push(run.join('\n'), '')
  return out.join('\n')
}

// ---- the envs ----

type Built = { program: string; cases: string }
type Env = {
  // the candidate as the program loads it: a package path, or a copy in the work folder
  place(candidate: string, spec: Spec, work: string): string
  build(file: string, work: string): string
  // one run's output, with the host, machine and load lines first
  run(built: Built): string
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const LINE = join(TERM_ROOT, 'host', 'line.js')

function buildNode(file: string, work: string): string {
  const out = join(work, 'out')
  mkdirSync(out, { recursive: true })
  const made = spawnSync(process.execPath, [LINE, 'make', file, '--emit', 'node', '--build', '--out', out, '--color', 'never', '--no-motion'], {
    cwd: TERM_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  writeFileSync(join(work, 'build.log'), `${made.stdout ?? ''}${made.stderr ?? ''}`)
  const built = join(out, 'bench.mjs')
  if (made.status !== 0 || !existsSync(built)) fail(`the build failed: ${join(work, 'build.log')}`)
  return built
}

function header(): string {
  const cpu = cpus()
  const date = new Date().toISOString().slice(0, 16)
  return `host node ${process.version}\nmachine ${cpu[0]?.model ?? 'unknown'} cores ${cpu.length}\nload ${loadavg()[0]!.toFixed(2)}\ndate ${date}\n`
}

function runNode(built: Built): string {
  const ran = spawnSync(process.execPath, [built.program], {
    cwd: TERM_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, [CASES_VARIABLE]: built.cases },
  })
  if (ran.status !== 0) fail(`the program exited ${ran.status}:\n${(ran.stderr ?? '').slice(-2000)}`)
  return header() + ran.stdout
}

// a candidate in the stdlib loads by its package path, so the program meets the module the stdlib itself loads
function packagePath(candidate: string, work: string): string {
  const stdlib = 'deck/base/code/'
  const path = relative(TERM_ROOT, candidate)
  if (path.startsWith(stdlib)) return `@term/base/${path.slice(stdlib.length).replace(/\.tree$/, '')}`
  const near = relative(work, candidate).replace(/\.tree$/, '')
  return near.startsWith('.') ? near : `./${near}`
}

const later = (item: string): Env => {
  const no = (): never => fail(`--env ${envName} is not wired yet: item ${item} adds its emit, build and run`)
  return { place: no, build: no, run: no }
}

const ENVS: Record<string, Env> = {
  node: { place: (candidate, _spec, work) => packagePath(candidate, work), build: buildNode, run: runNode },
  browser: {
    // node's V8 stands in for the browser: the candidate's browser cases read as node ones, and the browser shim found
    // before the node one
    place(candidate, spec, work) {
      const text = readFileSync(candidate, 'utf8')
      if (/^\s*load \.\.?\//m.test(text)) fail(`${candidate} loads a relative module: a browser copy cannot follow it`)
      writeFileSync(join(work, 'candidate.tree'), text.replace(/^(\s*)case browser$/gm, '$1case node'))
      // a browser shim whose code is the node one's (only comments differ) is not copied: a stdlib module in the
      // program's closure that docks the same global would bring the node file in beside the copy, and the two
      // declare every name twice (bit: "The symbol __bitSigned32 has already been declared")
      const shim = join(TERM_ROOT, 'deck/base/code/native/browser/runtime', `${spec.shim}.ts`)
      const twin = join(TERM_ROOT, 'deck/base/code/native/node/runtime', `${spec.shim}.ts`)
      const codeOf = (file: string): string => readFileSync(file, 'utf8').replace(/^\s*\/\/.*\n/gm, '')
      if (!existsSync(twin) || codeOf(shim) !== codeOf(twin)) {
        mkdirSync(join(work, 'runtime', 'node'), { recursive: true })
        copyFileSync(shim, join(work, 'runtime', 'node', `${spec.shim}.ts`))
      }
      return './candidate'
    },
    build: buildNode,
    run: runNode,
  },
  rust: later('term-self-host-001-1063'),
  swift: later('term-self-host-001-1063'),
  kotlin: later('term-self-host-001-1063'),
}

// ---- the table ----

type Measure = { shim: number; term: number; base: number; cases: number; equal: number; differ: number; unsafe: number }
type Run = { host: string; machine: string; load: number; date: string; ops: Map<string, Measure> }

function readRun(text: string, spec: Spec): Run {
  const ops = new Map<string, Measure>()
  let host = 'unknown'
  let machine = 'unknown'
  let load = Number.NaN
  let date = 'unknown'
  for (const line of text.split('\n')) {
    const m = line.match(
      /^op (\S+) shim-ps ([\d.]+) term-ps ([\d.]+) base-ps ([\d.]+) cases (\d+) equal (\d+) disagree (\d+) disagree-record (\d+) unsafe-answer (\d+)/,
    )
    if (m) {
      const [shim, term, base, cases, equal, plain, record, unsafe] = m.slice(2).map(Number) as number[]
      ops.set(m[1]!.slice(spec.shim.length + 1), { shim: shim!, term: term!, base: base!, cases: cases!, equal: equal!, differ: plain! + record!, unsafe: unsafe! })
    }
    if (line.startsWith('host ')) host = line.slice(5)
    if (line.startsWith('machine ')) machine = line.slice(8)
    if (line.startsWith('load ')) load = Number(line.slice(5))
    if (line.startsWith('date ')) date = line.slice(5)
    if (line.startsWith('  differ ')) console.log(line)
  }
  for (const { op } of spec.ops) if (!ops.has(op)) fail(`the run printed no line for ${op}`)
  return { host, machine, load, date, ops }
}

const tenth = (n: number): number => Math.round(n * 10) / 10
const hundredth = (n: number): number => Math.round(n * 100) / 100
const gross = (m: Measure): number => m.term / m.shim

function rows(spec: Spec, first: Run, second: Run | undefined): Row[] {
  return spec.ops.map(({ op }) => {
    const m = first.ops.get(op)!
    const again = second?.ops.get(op)
    const over = gross(m) > RULE && (again === undefined || gross(again) > RULE)
    return {
      op,
      shim_ns: tenth(m.shim / 1000),
      term_ns: tenth(m.term / 1000),
      loop_ns: tenth(m.base / 1000),
      gross_ratio: hundredth(gross(m)),
      // the net ratio means something only when the shim's call costs over 1 ns more than the loop around it
      net_ratio: m.shim - m.base < 1000 ? null : hundredth((m.term - m.base) / (m.shim - m.base)),
      cases: m.cases,
      equal: m.equal,
      differ: m.differ,
      past_safe_range: m.unsafe,
      rerun_gross_ratio: gross(m) > RULE && again ? hundredth(gross(again)) : null,
      state: over || m.differ > 0 || (again?.differ ?? 0) > 0 ? 'kept' : 'ported',
    }
  })
}

function table(label: string, list: Row[]): string {
  const lines = [
    '| op | shim ns | Term ns | loop ns | gross ratio | net ratio | cases | equal | differ | past safe range | re-run | state |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  ]
  for (const r of list) {
    lines.push(
      `| ${label}/${r.op} | ${r.shim_ns.toFixed(1)} | ${r.term_ns.toFixed(1)} | ${r.loop_ns.toFixed(1)} | ${r.gross_ratio.toFixed(2)} | ${r.net_ratio === null ? '-' : r.net_ratio.toFixed(2)} | ${r.cases} | ${r.equal} | ${r.differ} | ${r.past_safe_range} | ${r.rerun_gross_ratio === null ? '-' : r.rerun_gross_ratio.toFixed(2)} | ${r.state} |`,
    )
  }
  return lines.join('\n')
}

// ---- main ----

const env = ENVS[envName] ?? fail(`--env ${envName}: one of ${Object.keys(ENVS).join(', ')}`)
const specFile = join(SPECS, envName, `${shimName}.json`)
if (!existsSync(specFile)) fail(`no spec at ${relative(TERM_ROOT, specFile)}`)
const spec = JSON.parse(readFileSync(specFile, 'utf8')) as Spec
const label = `${envName}/${shimName}`
// the spec's candidate is a Term root path, read in the root, else beside this tool's own task/term (a staged copy)
const named = flag('--candidate')
const candidate = named
  ? resolve(TERM_ROOT, named)
  : ([TERM_ROOT, join(HERE, '..', '..')].map(root => resolve(root, spec.candidate)).find(existsSync) ?? resolve(TERM_ROOT, spec.candidate))
if (!existsSync(candidate)) fail(`no candidate at ${candidate}`)
const candidateName = named ? relative(TERM_ROOT, candidate) : spec.candidate
// a module that still docks the shim is the shim: there is nothing to measure
if (readFileSync(candidate, 'utf8').includes(`<global:${spec.shim}>`)) {
  fail(`${relative(TERM_ROOT, candidate)} still docks <global:${spec.shim}>: name the port's draft with --candidate`)
}
const runtimeEnv = envName === 'browser' ? 'browser' : 'node'
const runtime = join(TERM_ROOT, 'deck/base/code/native', runtimeEnv, 'runtime', `${spec.shim}.ts`)
if (!existsSync(runtime)) fail(`${relative(TERM_ROOT, runtime)} is gone: there is no shim left to time, the baseline stands as the record`)

const work = resolve(TERM_ROOT, flag('--work') ?? join('tmp', 'shim-bench', `${envName}-${shimName}`))
mkdirSync(work, { recursive: true })
const record = join(work, 'build.json')
let built: Built | undefined
if (LOGS.length === 0) {
  const load = env.place(candidate, spec, work)
  const file = join(work, 'bench.tree')
  writeFileSync(file, program(spec, label, load))
  const cases = join(work, 'cases.json')
  writeFileSync(cases, JSON.stringify(makeCases(spec)))
  built = { program: env.build(file, work), cases }
  writeFileSync(
    record,
    `${JSON.stringify({ line_sha256: sha(LINE), candidate: candidateName, candidate_sha256: sha(candidate), runtime: relative(TERM_ROOT, runtime), runtime_sha256: sha(runtime) }, null, 2)}\n`,
  )
  if (BUILD_ONLY) {
    console.log(`program ${built.program}\ncases ${built.cases}\nrun it with ${CASES_VARIABLE}=<cases> node <program>`)
    process.exit(0)
  }
} else if (!existsSync(record)) {
  fail(`--log reads the build record ${relative(TERM_ROOT, record)}: build with --build-only and the same --work first`)
}
const made = JSON.parse(readFileSync(record, 'utf8')) as Record<string, string>
if (made.candidate_sha256 !== sha(candidate)) fail(`${relative(TERM_ROOT, candidate)} changed since the build: build again`)

const runOnce = (n: number): Run => {
  const text = env.run(built!)
  writeFileSync(join(work, `run-${n}.log`), text)
  return readRun(text, spec)
}
const first = LOGS[0] ? readRun(readFileSync(LOGS[0], 'utf8'), spec) : runOnce(1)
const anyOver = spec.ops.some(({ op }) => gross(first.ops.get(op)!) > RULE)
const second = LOGS[1] ? readRun(readFileSync(LOGS[1], 'utf8'), spec) : anyOver && LOGS.length === 0 ? runOnce(2) : undefined
if (anyOver && second === undefined) console.log('an op reads over 1.2 and no re-run was given: it is kept on one run')
const list = rows(spec, first, second)
console.log(`${label}: ${first.host}, ${first.machine}, load ${first.load}`)
if (first.load >= 12) console.log(`load ${first.load} is 12 or over: the numbers are noisy (decision 132 point 2)`)
console.log(table(label, list))

if (CHECK) {
  const baselineFile = resolve(TERM_ROOT, flag('--baseline') ?? join(SPECS, envName, `${shimName}.baseline.json`))
  const before = existsSync(baselineFile) ? (JSON.parse(readFileSync(baselineFile, 'utf8')) as { ops: Row[] }) : { ops: [] }
  const wasKept = new Set(before.ops.filter(row => row.state === 'kept').map(row => row.op))
  const problems = list.flatMap(row => [
    ...(row.differ > 0 ? [`${row.op}: ${row.differ} cases differ`] : []),
    ...(wasKept.has(row.op) && row.gross_ratio <= RULE ? [`${row.op}: kept in the baseline, now ${row.gross_ratio}: it ports`] : []),
  ])
  for (const problem of problems) console.log(`FAIL ${problem}`)
  console.log(problems.length === 0 ? 'check: ok' : `check: ${problems.length} failing`)
  process.exit(problems.length === 0 ? 0 : 1)
}

const baselineFile = resolve(TERM_ROOT, flag('--baseline') ?? join(SPECS, envName, `${shimName}.baseline.json`))
mkdirSync(dirname(baselineFile), { recursive: true })
const baseline = {
  env: envName,
  shim: shimName,
  ...made,
  candidate: candidateName,
  measured: first.date,
  host: first.host,
  machine: first.machine,
  load: first.load,
  trials: TRIALS,
  rounds: spec.rounds,
  cases_per_op: SIZE,
  rule: `best of ${TRIALS}, an op over ${RULE} gross in two runs, or with any differ, is kept`,
  ops: list,
}
writeFileSync(baselineFile, `${JSON.stringify(baseline, null, 2)}\n`)
console.log(`wrote ${relative(TERM_ROOT, baselineFile)}`)
