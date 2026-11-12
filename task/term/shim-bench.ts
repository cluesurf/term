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
// <work>/runtime/node/, the folder the runtime prelude tries before the stdlib's). rust, swift and kotlin (item
// term-self-host-001-1063) emit the program for their own backend through `term make --emit <env> --build`: rustc -O
// (a cargo --release project when the program names a crate, as the stdlib's text and file do), swiftc -O, kotlinc
// to a jar run by java. Their program is typed: an op's arguments are floats (kind `float`), or, when the op names
// `args`, floats, integers and texts (items 1064 to 1066, the typed program below), read from a text file of one line
// a list, `|` between the values, each read by the host's own parser. Kotlin's ops are warmed
// first, at least 10,000 calls each on both sides, so the JIT has compiled them before any trial is timed.
//
// Run from the Term root.

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg, tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse, renderHead } from '@term/make/code/parser/tree'
import type { Node as TreeNode } from '@term/make/code/parser/tree'
import { TERM_ROOT } from './root'

// the first `load ./x` or `load ../x` a file holds at any depth, through the one parser
function relativeLoadOf(file: string, text: string): string | undefined {
  const parsed = parse({ file, text }) as { ok: boolean; tree?: { nodes: TreeNode[] } }
  if (!parsed.ok || !parsed.tree) fail(`${file} does not parse`)
  const headOf = (node: TreeNode | undefined): string | undefined => {
    const first = node?.kind === 'group' ? node.nodes[0] : undefined
    return first?.kind === 'name' ? renderHead(first) : undefined
  }
  const visit = (node: TreeNode): string | undefined => {
    if (node.kind !== 'group') return undefined
    const path = headOf(node) === 'load' ? headOf(node.nodes[1]) : undefined
    if (path?.startsWith('./') || path?.startsWith('../')) return path
    for (const child of node.nodes.slice(1)) {
      const found = visit(child)
      if (found) return found
    }
    return undefined
  }
  for (const node of parsed.tree!.nodes) {
    const found = visit(node)
    if (found) return found
  }
  return undefined
}

const HERE = dirname(fileURLToPath(import.meta.url))
const SPECS = join(HERE, 'shim-bench')
const TRIALS = 7
const SIZE = 2048
const RULE = 1.2
const CASES_VARIABLE = 'TERM_SHIM_BENCH_CASES'

type Kind = 'number' | 'boolean' | 'text' | 'dynamic' | 'float'
// `args`, on a native op only: each argument's kind (float, number or text), for an op whose arguments are not all
// floats (items 1064 to 1066). Absent, every argument is a float, as fmath's are
type Op = { op: string; shim_op: string; term_op: string; arity: number; kind: Kind; cases: string; args?: Kind[] }
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

// a float for the fmath ops: the unit range (asin, acos), small and wide magnitudes, halves (round's ties), the
// edges (signed zero, subnormals, the largest double, NaN, the infinities) and big integers past the safe range
const FLOAT_EDGES = [
  0, -0, 1, -1, 0.5, -0.5, 1.5, 2.5, -2.5, Math.PI, Math.PI / 2, -Math.PI, Math.E, 1e-310, 5e-324,
  1.7976931348623157e308, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 9007199254740993, 1e21,
]
function float(): number {
  switch (int(0, 5)) {
    case 0: return random() * 2 - 1
    case 1: return random() * 20 - 10
    case 2: return int(-50, 50) + pick([0, 0.5, -0.5, 0.25])
    case 3: return (random() * 2 - 1) * 10 ** int(-300, 300)
    case 4: return pick(FLOAT_EDGES)
    default: return random() * 1e6
  }
}

// ---- the native integer and text cases (items 1064 to 1066): an i64 is a bigint, so the edges stay exact ----

const I64_MAX = (1n << 63n) - 1n
const I64_MIN = -(1n << 63n)
// i64::MIN is left out: its absolute value has no i64 answer and the shim stops on it, which ends the program
const INT_EDGES = [0n, 1n, -1n, 2n, -2n, I64_MAX, I64_MIN + 1n, 1n << 53n, (1n << 53n) + 1n, -(1n << 53n) - 1n, 4294967295n, 4294967296n]
function bigInt(): bigint {
  switch (int(0, 4)) {
    case 0: return BigInt(int(-1000, 1000))
    case 1: return BigInt(int(-1e9, 1e9)) * BigInt(int(1, 1e9))
    case 2: return BigInt(Math.floor((random() * 2 - 1) * 2 ** 62)) * BigInt(pick([1, 2]))
    case 3: return pick(INT_EDGES)
    default: return BigInt(int(0, 100))
  }
}
// a power whose exact answer fits an i64, or one of the answered-directly cases (0, 1 and -1 to any exponent, an
// exponent past u32), never zero to a negative power, which stops
function powerPair(): unknown[] {
  for (;;) {
    const roll = random()
    if (roll < 0.1) return [pick([0n, 1n, -1n]), pick([0n, 1n, 2n, 3n, 4294967296n, 4294967297n, 1n << 40n]), 'plain']
    if (roll < 0.25) {
      const base = BigInt(pick([1, -1, 2, -2, 3, 7, -1000]))
      return [base, BigInt(-int(1, 5)), 'plain']
    }
    const base = BigInt(int(-20, 20))
    const exponent = BigInt(int(0, 64))
    if (base === 0n && exponent < 0n) continue
    const answer = base ** exponent
    if (answer <= I64_MAX && answer >= I64_MIN) return [base, exponent, 'plain']
  }
}
const WORDS = ['', 'a', 'ab', 'abc', 'hello', 'Hello World', '  padded  ', '\ttab\n', 'ß', 'İstanbul', 'ǅ', 'straße',
  'é', 'é', '😀', '𝔸𝔹', 'naïve café', 'ΑΒΓ', 'ффф', '中文字', 'a|b', 'x,y', '0', '-12', 'MiXeD', 'ﬀ', '\u0000', 'aaa']
function textValue(): string {
  const roll = random()
  if (roll < 0.6) return pick(WORDS)
  if (roll < 0.9) return Array.from({ length: int(1, 3) }, () => pick(WORDS)).join(pick(['', ' ', '-']))
  return Array.from({ length: int(0, 40) }, () => String.fromCodePoint(pick([65, 97, 32, 0xe9, 0x1f600]))).join('')
}
// a part of the text half the time, so contains, starts-with and ends-with answer true as often as false
function partOf(text: string): string {
  const runes = [...text]
  if (random() < 0.5 || runes.length === 0) return textValue()
  const start = int(0, runes.length - 1)
  const end = int(start, runes.length)
  return runes.slice(random() < 0.3 ? 0 : start, random() < 0.3 ? runes.length : end).join('')
}
const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8')
// valid hex of a text most of the time, then odd lengths, letters outside hex, upper case, bytes that are not UTF-8
function hexText(): string {
  switch (int(0, 5)) {
    case 0: return utf8(textValue()).toString('hex').toUpperCase()
    case 1: return utf8(textValue()).toString('hex').slice(1)
    case 2: return pick(['zz', 'g0', '0x41', ' 41', 'ff', 'c3', 'c328', 'fffe'])
    default: return utf8(textValue()).toString('hex')
  }
}
// valid base64 of a text most of the time, then no padding, a letter outside the alphabet, padding inside, the URL
// alphabet, bytes that are not UTF-8
function base64Text(): string {
  switch (int(0, 6)) {
    case 0: return utf8(textValue()).toString('base64').replace(/=+$/, '')
    case 1: return pick(['a$b', 'ab cd', '-_-_', '/w==', 'wyg=', '=QQ==', 'QQ=QQ', '////', 'YQ', 'Y'])
    case 2: return utf8(textValue()).toString('base64').replace(/^(.)/, '=$1')
    default: return utf8(textValue()).toString('base64')
  }
}

// each case is its arguments, then 'plain' or 'record' (a case holding a record, counted apart when it differs)
const many = (n: number, make: () => unknown[]): unknown[][] => Array.from({ length: n }, make)
const GENERATORS: Record<string, (n: number) => unknown[][]> = {
  // the bit generators (bit-*, word-*) went with the bit shim on node and browser (items 1070 and 1090): its
  // baseline is in git history, task/term/shim-bench/<env>/bit.baseline.json before 1090
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
  'float-singles': n => many(n, () => [float(), 'plain']),
  // a second argument that is a small integer half the time: pow's integer exponents, atan2's axes
  'float-pairs': n => many(n, () => [float(), random() < 0.5 ? int(-5, 5) : float(), 'plain']),
  // the native integer and text generators (items 1064 to 1066)
  'int-singles': n => many(n, () => [bigInt(), 'plain']),
  'int-pairs': n => many(n, () => [bigInt(), random() < 0.2 ? pick(INT_EDGES) : bigInt(), 'plain']),
  'power-pairs': n => many(n, powerPair),
  'text-singles': n => many(n, () => [textValue(), 'plain']),
  'text-pairs': n => many(n, () => { const text = textValue(); return [text, partOf(text), 'plain'] }),
  'replace-triples': n => many(n, () => { const text = textValue(); return [text, random() < 0.1 ? '' : partOf(text), textValue(), 'plain'] }),
  'repeat-pairs': n => many(n, () => [textValue(), BigInt(int(0, 5)), 'plain']),
  // a start inside the text or one past it, an end from one before the start to past the end
  'slice-triples': n =>
    many(n, () => {
      const text = textValue()
      const size = [...text].length
      const start = int(0, size + 1)
      return [text, BigInt(start), BigInt(Math.max(0, int(start - 1, size + 3))), 'plain']
    }),
  'hex-singles': n => many(n, () => [hexText(), 'plain']),
  'base64-singles': n => many(n, () => [base64Text(), 'plain']),
  // swift: a square root or logarithm of a number below 1 is NaN or an infinity, and Int() of it traps
  'int-positive': n => many(n, () => { const v = bigInt(); return [v > 0n ? v : v === 0n ? 1n : -v, 'plain'] }),
  // swift slices by characters and traps outside them: both ends inside the text's grapheme clusters, in order
  'slice-graphemes': n =>
    many(n, () => {
      const text = textValue()
      const size = [...new Intl.Segmenter().segment(text)].length
      const start = int(0, size)
      return [text, BigInt(start), BigInt(int(start, size)), 'plain']
    }),
  // kotlin raises on a pair that is not hex and on malformed base64: only the inputs it answers
  'hex-valid-singles': n =>
    many(n, () => [random() < 0.15 ? pick(['ff', 'c3', 'c328', 'fffe', 'c', 'ABC']) : utf8(textValue()).toString('hex').slice(random() < 0.2 ? 1 : 0), 'plain']),
  'base64-valid-singles': n =>
    many(n, () => [random() < 0.15 ? pick(['/w==', 'wyg=', '////', 'YQ', 'YWI']) : utf8(textValue()).toString('base64').replace(random() < 0.3 ? /=+$/ : /^$/, ''), 'plain']),
  // an index-of: a text, a part of it half the time, a start from before the text to past it
  'index-triples': n => many(n, () => { const text = textValue(); return [text, partOf(text), BigInt(int(-2, [...text].length + 2)), 'plain'] }),
  'slice-from-pairs': n => many(n, () => { const text = textValue(); return [text, BigInt(int(-2, [...text].length + 2)), 'plain'] }),
  'repeat-signed-pairs': n => many(n, () => [textValue(), BigInt(int(-3, 5)), 'plain']),
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

// ---- the native program: the same checks, timers, trials and lines, typed ----

type NativeName = 'rust' | 'swift' | 'kotlin'
const NATIVES: NativeName[] = ['rust', 'swift', 'kotlin']
// a JIT compiles an op only once it is hot: kotlin's ops run this many times on both sides before the first trial
const WARM_CALLS: Record<NativeName, number> = { rust: 0, swift: 0, kotlin: 10000 }

// a float as the host parsers read it back exactly: the shortest text that round-trips, minus zero kept
const floatText = (value: unknown): string => {
  if (typeof value !== 'number') fail(`a native case holds ${JSON.stringify(value)}, not a float`)
  return Object.is(value, -0) ? '-0' : String(value)
}

// two lines an op, its first arguments and its second (the first again for a one-argument op), `|` between values
function nativeCases(spec: Spec, cases: unknown[][][]): string {
  return spec.ops
    .flatMap(({ arity }, index) => {
      const list = cases[index]!
      const first = list.map(c => floatText(c[0]))
      return [first.join('|'), arity === 2 ? list.map(c => floatText(c[1])).join('|') : first.join('|')]
    })
    .join('\n')
}

function nativeTimer(task: string, call: string): string {
  return [
    `task ${task}`,
    '  take xs, like list, like float',
    '  take ys, like list, like float',
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
    '        hook test, is-below(i, xs/length)',
    '        hook hold',
    '          save x, xs/{i}',
    '          save y, ys/{i}',
    `          save out, ${call}`,
    // every side reads both arguments and compares its answer with the second, so the sink costs the same
    '          fork test, is-below(out, y)',
    '            hold',
    '              save sink, add(sink, 1)',
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

function nativeProgram(spec: Spec, label: string, load: string, native: NativeName): string {
  for (const { op, kind, arity } of spec.ops) {
    if (kind !== 'float') fail(`${op}: a native spec takes float ops only, and this one is ${kind}`)
    if (arity !== 1 && arity !== 2) fail(`${op}: a native op takes one or two arguments`)
  }
  const alias = spec.shim
  const args = (arity: number): string => (arity === 2 ? 'x, y' : 'x')
  const out: string[] = [
    `# Generated by task/term/shim-bench.ts: the ${label} shim against its Term candidate, ${SIZE} cases an op, best of`,
    `# ${TRIALS} trials, in picoseconds a call. Do not edit.`,
    '',
    'load @term/base/console\n  find log\n',
    'load @term/base/clock\n  find read-nanoseconds\n',
    'load @term/base/list\n  find push\n',
    'load @term/base/text\n  find split\n',
    'load @term/base/file\n  find read, name read-cases\n',
    'load @term/base/environment\n  find variable, name read-variable\n',
    `dock load\n  load <global:${spec.shim}>, name ${alias}\n`,
    `load ${load}`,
    ...[...new Set(spec.ops.map(op => op.term_op))].map(found => `  find ${found}`),
    '',
    '# a case as the host reads a float',
    'bind case-float',
    '  take value, like text',
    '  like float',
    // node and browser never run this program, and a bind must hold a case for every backend
    '  case node',
    '    text <Number($value)>',
    '  case browser',
    '    text <Number($value)>',
    '  case rust',
    '    text <$value.parse::<f64>().unwrap_or(f64::NAN)>',
    '  case swift',
    '    text <(Double($value) ?? Double.nan)>',
    '  case kotlin',
    '    text <($value).toDouble()>',
    '',
    'task floats-of',
    '  take line, like text',
    '  like list, like float',
    '',
    '  save found, like list, like float',
    '    make list',
    '  walk split(line, <|>)',
    '    take one',
    '    push(found, case-float(one))',
    '  back found',
    '',
  ]
  for (const { op, shim_op, term_op, arity } of spec.ops) {
    const shimCall = `${alias}/${shim_op}(${args(arity)})`
    const termCall = `${term_op}(${args(arity)})`
    out.push(
      [
        '# every case once: the agreeing ones are kept for timing',
        `task check-${op}`,
        '  take xs, like list, like float',
        '  take ys, like list, like float',
        '  take kept-x, like list, like float',
        '  take kept-y, like list, like float',
        '  like text',
        '',
        '  save equal, 0',
        '  save plain, 0',
        '  save shown, 0',
        '  save i, 0',
        '  walk test',
        '    hook test, is-below(i, xs/length)',
        '    hook hold',
        '      save x, xs/{i}',
        '      save y, ys/{i}',
        `      save want, ${shimCall}`,
        `      save got, ${termCall}`,
        // NaN answers NaN on both sides: equal
        '      fork test, or(is-equal(got, want), and(is-unequal(got, got), is-unequal(want, want)))',
        '        hold',
        '          save equal, add(equal, 1)',
        '          push(kept-x, x)',
        '          push(kept-y, y)',
        '        miss',
        '          save plain, add(plain, 1)',
        '          fork test, is-below(shown, 4)',
        '            hold',
        `              log(<  differ ${op} [{x}, {y}] shim {want} term {got}>)`,
        '              save shown, add(shown, 1)',
        '      save i, add(i, 1)',
        '  back <cases {xs/length} equal {equal} disagree {plain} disagree-record 0 unsafe-answer 0>',
        '',
      ].join('\n'),
    )
    out.push(nativeTimer(`time-shim-${op}`, shimCall))
    out.push(nativeTimer(`time-term-${op}`, termCall))
    out.push(nativeTimer(`time-base-${op}`, 'x'))
  }
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
  const warm = WARM_CALLS[native]
  const run = [
    'task run',
    '  mark async',
    '',
    `  log(<shim ${label} rounds ${spec.rounds} trials ${TRIALS} warm ${warm}>)`,
    `  save all, split(read-cases(read-variable(<${CASES_VARIABLE}>)), <\\n>)`,
  ]
  spec.ops.forEach(({ op }, index) => {
    run.push(
      `  save xs-${op}, floats-of(all/${2 * index})`,
      `  save ys-${op}, floats-of(all/${2 * index + 1})`,
      `  save kept-x-${op}, like list, like float`,
      '    make list',
      `  save kept-y-${op}, like list, like float`,
      '    make list',
      `  save verdict-${op}, check-${op}(xs-${op}, ys-${op}, kept-x-${op}, kept-y-${op})`,
    )
    if (warm > 0) {
      // rounds enough that each side makes at least `warm` calls over the kept cases
      run.push(
        `  fork test, is-above(kept-x-${op}/length, 0)`,
        '    hold',
        `      save warm-${op}, 1`,
        '      walk test',
        `        hook test, is-below(multiply(warm-${op}, kept-x-${op}/length), ${warm})`,
        '        hook hold',
        `          save warm-${op}, add(warm-${op}, 1)`,
        `      save warmed-${op}, add(time-shim-${op}(kept-x-${op}, kept-y-${op}, warm-${op}), time-term-${op}(kept-x-${op}, kept-y-${op}, warm-${op}))`,
        `      save warmed-${op}, add(warmed-${op}, time-base-${op}(kept-x-${op}, kept-y-${op}, warm-${op}))`,
        `      fork test, is-equal(warmed-${op}, -1)`,
        '        hold',
        '          log(<warm>)',
      )
    }
    const kept = `kept-x-${op}, kept-y-${op}, ${spec.rounds}`
    run.push(
      `  save shim-${op}, -1`,
      `  save term-${op}, -1`,
      `  save base-${op}, -1`,
      `  save trial-${op}, 0`,
      '  walk test',
      `    hook test, is-below(trial-${op}, ${TRIALS})`,
      '    hook hold',
      `      fork test, is-equal(modulo(trial-${op}, 2), 0)`,
      '        hold',
      `          save shim-${op}, best(shim-${op}, time-shim-${op}(${kept}))`,
      `          save term-${op}, best(term-${op}, time-term-${op}(${kept}))`,
      '        miss',
      `          save term-${op}, best(term-${op}, time-term-${op}(${kept}))`,
      `          save shim-${op}, best(shim-${op}, time-shim-${op}(${kept}))`,
      `      save base-${op}, best(base-${op}, time-base-${op}(${kept}))`,
      `      save trial-${op}, add(trial-${op}, 1)`,
      `  save calls-${op}, multiply(kept-x-${op}/length, ${spec.rounds})`,
      `  log(<op ${spec.shim}/${op} shim-ps {per-call(shim-${op}, calls-${op})} term-ps {per-call(term-${op}, calls-${op})} base-ps {per-call(base-${op}, calls-${op})} {verdict-${op}}>)`,
    )
  })
  out.push(run.join('\n'), '')
  return out.join('\n')
}

// ---- the typed native program (items 1064 to 1066): an op whose arguments are integers or texts ----
//
// The same checks, timers, trials and lines as the float program above, with each argument a typed list of its own
// kind. A float is written as floatText writes it, an integer as its decimal digits (exact past 2^53: the case is a
// bigint), a text as its code points in decimal with `,` between (empty for the empty text), so no value can hold the
// `|` between values or the newline between lines. Only the case parsing runs host code of the harness's own, before
// any timing. Each op's sink reads its answer the same way on both sides: a number below 0, a boolean, a text equal to
// the empty text.

const TYPED: Partial<Record<Kind, string>> = { float: 'float', number: 'number', text: 'text' }
const argsOf = (op: Op): Kind[] => op.args ?? Array.from({ length: op.arity }, () => 'float' as Kind)

function valueText(kind: Kind, value: unknown): string {
  if (kind === 'float') return floatText(value)
  if (kind === 'number') {
    if (typeof value === 'bigint') return String(value)
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value)
    return fail(`a native integer case holds ${String(value)}`)
  }
  if (typeof value !== 'string') return fail(`a native text case holds ${String(value)}`)
  return [...value].map(rune => rune.codePointAt(0)).join(',')
}

// one line an argument, the ops in their order
function typedCases(spec: Spec, cases: unknown[][][]): string {
  return spec.ops.flatMap((op, index) => argsOf(op).map((kind, at) => cases[index]!.map(c => valueText(kind, c[at])).join('|'))).join('\n')
}

function typedSink(kind: Kind): string[] {
  switch (kind) {
    case 'boolean': return ['fork test, out', '  hold', '    save sink, add(sink, 1)']
    case 'text': return ['fork test, is-equal(out, <>)', '  hold', '    save sink, add(sink, 1)']
    default: return ['fork test, is-below(out, 0)', '  hold', '    save sink, add(sink, 1)']
  }
}

const listsOf = (args: Kind[], prefix: string): string[] => args.map((kind, at) => `  take ${prefix}${at}, like list, like ${TYPED[kind]}`)
const readsOf = (args: Kind[], indent: string): string[] => args.map((_, at) => `${indent}save x${at}, a${at}/{i}`)
const callOf = (name: string, args: Kind[]): string => `${name}(${args.map((_, at) => `x${at}`).join(', ')})`

function typedTimer(task: string, call: string, args: Kind[], kind: Kind): string {
  return [
    `task ${task}`,
    ...listsOf(args, 'a'),
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
    '        hook test, is-below(i, a0/length)',
    '        hook hold',
    ...readsOf(args, '          '),
    `          save out, ${call}`,
    ...typedSink(kind).map(line => `          ${line}`),
    '          save i, add(i, 1)',
    '      save r, add(r, 1)',
    '  save took, subtract(read-nanoseconds(), start)',
    '  fork test, is-equal(sink, -1)',
    '    hold',
    '      bench-log(<sink>)',
    '  back took',
    '',
  ].join('\n')
}

function typedProgram(spec: Spec, label: string, load: string, native: NativeName): string {
  for (const op of spec.ops) {
    const args = argsOf(op)
    if (args.length !== op.arity) fail(`${op.op}: args names ${args.length} kinds for arity ${op.arity}`)
    if (args.length < 1) fail(`${op.op}: a native op takes one argument or more`)
    for (const kind of args) if (!TYPED[kind]) fail(`${op.op}: a native argument is a float, a number or a text, not ${kind}`)
    if (!['float', 'number', 'text', 'boolean'].includes(op.kind)) fail(`${op.op}: a native answer is a float, number, text or boolean`)
  }
  const alias = spec.shim
  const out: string[] = [
    `# Generated by task/term/shim-bench.ts: the ${label} shim against its Term candidate, ${SIZE} cases an op, best of`,
    `# ${TRIALS} trials, in picoseconds a call. Do not edit.`,
    '',
    // the console's log under a name of its own: a bind a candidate defines as log (imath's) answers to its own name
    // even when the program finds it under another, and met console's log at every call ("expected number, found text")
    'load @term/base/console\n  find log, name bench-log\n',
    'load @term/base/clock\n  find read-nanoseconds\n',
    'load @term/base/list\n  find push\n',
    'load @term/base/text\n  find split\n',
    'load @term/base/file\n  find read, name read-cases\n',
    'load @term/base/environment\n  find variable, name read-variable\n',
    `dock load\n  load <global:${spec.shim}>, name ${alias}\n`,
    `load ${load}`,
    // each candidate task under its own name, so one named like a harness task (imath's log) never meets it
    ...[...new Set(spec.ops.map(op => op.term_op))].map(found => `  find ${found}, name candidate-${found}`),
    '',
    // node and browser never run this program, and a bind must hold a case for every backend
    'bind case-float',
    '  take value, like text',
    '  like float',
    '  case node',
    '    text <Number($value)>',
    '  case browser',
    '    text <Number($value)>',
    '  case rust',
    '    text <$value.parse::<f64>().unwrap_or(f64::NAN)>',
    '  case swift',
    '    text <(Double($value) ?? Double.nan)>',
    '  case kotlin',
    '    text <($value).toDouble()>',
    '',
    'bind case-integer',
    '  take value, like text',
    '  like number',
    '  case node',
    '    text <Number($value)>',
    '  case browser',
    '    text <Number($value)>',
    '  case rust',
    '    text <$value.parse::\\<i64\\>().unwrap_or(0)>',
    '  case swift',
    '    text <(Int($value) ?? 0)>',
    '  case kotlin',
    '    text <($value).toLong()>',
    '',
    'bind case-rune',
    '  take code, like number',
    '  like text',
    '  case node',
    '    text <String.fromCodePoint($code)>',
    '  case browser',
    '    text <String.fromCodePoint($code)>',
    '  case rust',
    '    text <char::from_u32($code as u32).map_or(String::new(), |rune| rune.to_string())>',
    '  case swift',
    '    text <(UnicodeScalar(Int($code)).map(String.init) ?? "")>',
    '  case kotlin',
    '    text <String(Character.toChars(($code).toInt()))>',
    '',
    'task floats-of',
    '  take line, like text',
    '  like list, like float',
    '',
    '  save found, like list, like float',
    '    make list',
    '  walk split(line, <|>)',
    '    take one',
    '    push(found, case-float(one))',
    '  back found',
    '',
    'task numbers-of',
    '  take line, like text',
    '  like list, like number',
    '',
    '  save found, like list, like number',
    '    make list',
    '  walk split(line, <|>)',
    '    take one',
    '    push(found, case-integer(one))',
    '  back found',
    '',
    '# a text from its code points, `,` between them',
    'task text-of-codes',
    '  take field, like text',
    '  like text',
    '',
    '  save found, <>',
    '  fork test, is-equal(field, <>)',
    '    hold',
    '      back found',
    '  walk split(field, <,>)',
    '    take one',
    '    save found, <{found}{case-rune(case-integer(one))}>',
    '  back found',
    '',
    'task texts-of',
    '  take line, like text',
    '  like list, like text',
    '',
    '  save found, like list, like text',
    '    make list',
    '  walk split(line, <|>)',
    '    take one',
    '    push(found, text-of-codes(one))',
    '  back found',
    '',
  ]
  const READER: Record<string, string> = { float: 'floats-of', number: 'numbers-of', text: 'texts-of' }
  for (const op of spec.ops) {
    const args = argsOf(op)
    const shimCall = callOf(`${alias}/${op.shim_op}`, args)
    const termCall = callOf(`candidate-${op.term_op}`, args)
    const same = op.kind === 'float' ? 'or(is-equal(got, want), and(is-unequal(got, got), is-unequal(want, want)))' : 'is-equal(got, want)'
    out.push(
      [
        '# every case once: the agreeing ones are kept for timing',
        `task check-${op.op}`,
        ...listsOf(args, 'a'),
        ...listsOf(args, 'k'),
        '  like text',
        '',
        '  save equal, 0',
        '  save plain, 0',
        '  save shown, 0',
        '  save i, 0',
        '  walk test',
        '    hook test, is-below(i, a0/length)',
        '    hook hold',
        ...readsOf(args, '      '),
        `      save want, ${shimCall}`,
        `      save got, ${termCall}`,
        `      fork test, ${same}`,
        '        hold',
        '          save equal, add(equal, 1)',
        ...args.map((_, at) => `          push(k${at}, x${at})`),
        '        miss',
        '          save plain, add(plain, 1)',
        '          fork test, is-below(shown, 4)',
        '            hold',
        `              bench-log(<  differ ${op.op} [${args.map((_, at) => `{x${at}}`).join(', ')}] shim {want} term {got}>)`,
        '              save shown, add(shown, 1)',
        '      save i, add(i, 1)',
        '  back <cases {a0/length} equal {equal} disagree {plain} disagree-record 0 unsafe-answer 0>',
        '',
      ].join('\n'),
    )
    out.push(typedTimer(`time-shim-${op.op}`, shimCall, args, op.kind))
    out.push(typedTimer(`time-term-${op.op}`, termCall, args, op.kind))
    // the loop alone: every argument read, the first one sunk as its own kind
    out.push(typedTimer(`time-base-${op.op}`, 'x0', args, args[0]!))
  }
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
  const warm = WARM_CALLS[native]
  const run = [
    'task run',
    '  mark async',
    '',
    `  bench-log(<shim ${label} rounds ${spec.rounds} trials ${TRIALS} warm ${warm}>)`,
    `  save all, split(read-cases(read-variable(<${CASES_VARIABLE}>)), <\\n>)`,
  ]
  let line = 0
  for (const op of spec.ops) {
    const args = argsOf(op)
    const name = op.op
    args.forEach((kind, at) => {
      run.push(`  save a${at}-${name}, ${READER[kind]}(all/${line})`)
      run.push(`  save k${at}-${name}, like list, like ${TYPED[kind]}`, '    make list')
      line += 1
    })
    const all = (prefix: string): string => args.map((_, at) => `${prefix}${at}-${name}`).join(', ')
    run.push(`  save verdict-${name}, check-${name}(${all('a')}, ${all('k')})`)
    if (warm > 0) {
      run.push(
        `  fork test, is-above(k0-${name}/length, 0)`,
        '    hold',
        `      save warm-${name}, 1`,
        '      walk test',
        `        hook test, is-below(multiply(warm-${name}, k0-${name}/length), ${warm})`,
        '        hook hold',
        `          save warm-${name}, add(warm-${name}, 1)`,
        `      save warmed-${name}, add(time-shim-${name}(${all('k')}, warm-${name}), time-term-${name}(${all('k')}, warm-${name}))`,
        `      save warmed-${name}, add(warmed-${name}, time-base-${name}(${all('k')}, warm-${name}))`,
        `      fork test, is-equal(warmed-${name}, -1)`,
        '        hold',
        '          bench-log(<warm>)',
      )
    }
    const kept = `${all('k')}, ${spec.rounds}`
    run.push(
      `  save shim-${name}, -1`,
      `  save term-${name}, -1`,
      `  save base-${name}, -1`,
      `  save trial-${name}, 0`,
      '  walk test',
      `    hook test, is-below(trial-${name}, ${TRIALS})`,
      '    hook hold',
      `      fork test, is-equal(modulo(trial-${name}, 2), 0)`,
      '        hold',
      `          save shim-${name}, best(shim-${name}, time-shim-${name}(${kept}))`,
      `          save term-${name}, best(term-${name}, time-term-${name}(${kept}))`,
      '        miss',
      `          save term-${name}, best(term-${name}, time-term-${name}(${kept}))`,
      `          save shim-${name}, best(shim-${name}, time-shim-${name}(${kept}))`,
      `      save base-${name}, best(base-${name}, time-base-${name}(${kept}))`,
      `      save trial-${name}, add(trial-${name}, 1)`,
      `  save calls-${name}, multiply(k0-${name}/length, ${spec.rounds})`,
      `  bench-log(<op ${spec.shim}/${name} shim-ps {per-call(shim-${name}, calls-${name})} term-ps {per-call(term-${name}, calls-${name})} base-ps {per-call(base-${name}, calls-${name})} {verdict-${name}}>)`,
    )
  }
  out.push(run.join('\n'), '')
  return out.join('\n')
}

// a spec whose every op takes floats and answers a float is fmath's program, unchanged
const isFloatSpec = (spec: Spec): boolean => spec.ops.every(op => op.kind === 'float' && argsOf(op).every(kind => kind === 'float'))

// ---- the envs ----

type Built = { program: string; cases: string }
type Env = {
  // a native env: its program is the typed one, its cases a text file
  native?: NativeName
  // the candidate as the program loads it: a package path, or a copy in the work folder
  place(candidate: string, spec: Spec, work: string): string
  build(file: string, work: string): string
  // one run's output, with the host, machine and load lines first
  run(built: Built): string
}

const sha = (file: string): string => createHash('sha256').update(readFileSync(file)).digest('hex')
const LINE = join(TERM_ROOT, 'host', 'line.js')

// what each target's build leaves in the out folder, named for bench.tree (deck/call/code/native-build.ts)
const ARTIFACT: Record<string, string> = { node: 'bench.mjs', rust: 'bench', swift: 'bench', kotlin: 'bench.jar' }

function buildFor(target: 'node' | NativeName): (file: string, work: string) => string {
  return (file, work) => {
    const out = join(work, 'out')
    mkdirSync(out, { recursive: true })
    const made = spawnSync(process.execPath, [LINE, 'make', file, '--emit', target, '--build', '--out', out, '--color', 'never', '--no-motion'], {
      cwd: TERM_ROOT,
      encoding: 'utf8',
      maxBuffer: 1 << 28,
    })
    writeFileSync(join(work, 'build.log'), `${made.stdout ?? ''}${made.stderr ?? ''}`)
    // a rust program that names a crate (the stdlib's text and file reach some) is a cargo project, built --release
    const cargo = join(out, 'bench-cargo', 'target', 'release', 'bench')
    const built = target === 'rust' && existsSync(cargo) ? cargo : join(out, ARTIFACT[target]!)
    if (made.status !== 0 || !existsSync(built)) fail(`the build failed: ${join(work, 'build.log')}`)
    return built
  }
}
const buildNode = buildFor('node')

// the first line a toolchain prints of its version, for the run's host line
function versionOf(command: string, args: string[]): string {
  const ran = spawnSync(command, args, { encoding: 'utf8' })
  return `${ran.stdout ?? ''}${ran.stderr ?? ''}`.split('\n').find(line => line.trim() !== '')?.trim() ?? `${command} unknown`
}

function header(host: string): string {
  const cpu = cpus()
  const date = new Date().toISOString().slice(0, 16)
  return `host ${host}\nmachine ${cpu[0]?.model ?? 'unknown'} cores ${cpu.length}\nload ${loadavg()[0]!.toFixed(2)}\ndate ${date}\n`
}

function runCommand(command: string[], built: Built, host: string): string {
  const ran = spawnSync(command[0]!, command.slice(1), {
    cwd: TERM_ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 28,
    env: { ...process.env, [CASES_VARIABLE]: built.cases },
  })
  if (ran.status !== 0) fail(`the program exited ${ran.status}:\n${(ran.stderr ?? '').slice(-2000)}`)
  return header(host) + ran.stdout
}

function runNode(built: Built): string {
  return runCommand([process.execPath, built.program], built, `node ${process.version}`)
}

// the classpath of the Kotlin backend's runtime, where native-build.ts reads it: absent, the jar runs alone
function kotlinClasspath(): string | undefined {
  const file = join(process.env.TERM_NATIVE_CACHE ?? join(process.env.TMPDIR ?? tmpdir(), 'term-native'), 'kotlin', 'classpath.txt')
  return existsSync(file) ? readFileSync(file, 'utf8').trim() || undefined : undefined
}

const NATIVE_ENVS: Record<NativeName, Env> = {
  rust: {
    native: 'rust',
    place: (candidate, _spec, work) => packagePath(candidate, work),
    build: buildFor('rust'),
    run: built => runCommand([built.program], built, versionOf('rustc', ['--version'])),
  },
  swift: {
    native: 'swift',
    place: (candidate, _spec, work) => packagePath(candidate, work),
    build: buildFor('swift'),
    run: built => runCommand([built.program], built, versionOf('swiftc', ['--version'])),
  },
  kotlin: {
    native: 'kotlin',
    place: (candidate, _spec, work) => packagePath(candidate, work),
    build: buildFor('kotlin'),
    run(built) {
      // the main class kotlinc names for bench.kt, with the runtime's jars beside the program's
      const classpath = kotlinClasspath()
      const command = ['java', '--enable-native-access=ALL-UNNAMED', '-cp', classpath ? `${built.program}:${classpath}` : built.program, 'BenchKt']
      return runCommand(command, built, `${versionOf('java', ['-version'])}, ${versionOf('kotlinc', ['-version'])}`)
    },
  },
}

// a candidate in the stdlib loads by its package path, so the program meets the module the stdlib itself loads
function packagePath(candidate: string, work: string): string {
  const stdlib = 'deck/base/code/'
  const path = relative(TERM_ROOT, candidate)
  if (path.startsWith(stdlib)) return `@term/base/${path.slice(stdlib.length).replace(/\.tree$/, '')}`
  const near = relative(work, candidate).replace(/\.tree$/, '')
  return near.startsWith('.') ? near : `./${near}`
}

const ENVS: Record<string, Env> = {
  node: { place: (candidate, _spec, work) => packagePath(candidate, work), build: buildNode, run: runNode },
  browser: {
    // node's V8 stands in for the browser: the candidate's browser cases read as node ones, and the browser shim found
    // before the node one
    place(candidate, spec, work) {
      const text = readFileSync(candidate, 'utf8')
      const near = relativeLoadOf(candidate, text)
      if (near) fail(`${candidate} loads a relative module (${near}): a browser copy cannot follow it`)
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
  ...NATIVE_ENVS,
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
// the shim the program docks: the browser's own, a native env's own, else node's
const runtimeEnv = envName === 'browser' || env.native ? envName : 'node'
const RUNTIME_EXTENSION: Record<string, string> = { rust: 'rs', swift: 'swift', kotlin: 'kt' }
const runtime = join(TERM_ROOT, 'deck/base/code/native', runtimeEnv, 'runtime', `${spec.shim}.${RUNTIME_EXTENSION[runtimeEnv] ?? 'ts'}`)
if (!existsSync(runtime)) fail(`${relative(TERM_ROOT, runtime)} is gone: there is no shim left to time, the baseline stands as the record`)

const work = resolve(TERM_ROOT, flag('--work') ?? join('tmp', 'shim-bench', `${envName}-${shimName}`))
mkdirSync(work, { recursive: true })
const record = join(work, 'build.json')
let built: Built | undefined
if (LOGS.length === 0) {
  const load = env.place(candidate, spec, work)
  const file = join(work, 'bench.tree')
  const typed = env.native !== undefined && !isFloatSpec(spec)
  writeFileSync(
    file,
    env.native ? (typed ? typedProgram(spec, label, load, env.native) : nativeProgram(spec, label, load, env.native)) : program(spec, label, load),
  )
  const cases = join(work, env.native ? 'cases.txt' : 'cases.json')
  writeFileSync(cases, env.native ? (typed ? typedCases(spec, makeCases(spec)) : nativeCases(spec, makeCases(spec))) : JSON.stringify(makeCases(spec)))
  built = { program: env.build(file, work), cases }
  writeFileSync(
    record,
    `${JSON.stringify({ line_sha256: sha(LINE), candidate: candidateName, candidate_sha256: sha(candidate), runtime: relative(TERM_ROOT, runtime), runtime_sha256: sha(runtime) }, null, 2)}\n`,
  )
  if (BUILD_ONLY) {
    const how = env.native === 'kotlin' ? 'java -cp <program>[:<runtime classpath>] BenchKt' : env.native ? '<program>' : 'node <program>'
    console.log(`program ${built.program}\ncases ${built.cases}\nrun it with ${CASES_VARIABLE}=<cases> ${how}`)
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
