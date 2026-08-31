// Is a GENERATED reader as fast as the hand-written one it would replace?
//
// format-mill-0007 swaps each dialect's hand-written `code.tree` reader for the one feed-mill generates from its
// `mine.tree`. That trade is only worth making if the generated reader is not dramatically slower, and "not
// dramatically slower" is a claim that has to be measured on the same input, in the same process, against the same
// compiled output — not guessed from the shape of the emitted code.
//
// BOTH READERS IN ONE MODULE. The generated `read-hex` and the hand-written one are compiled together through the
// ordinary pipeline (the second imported under an alias so the flat namespace does not collide), emitted to one
// TypeScript file, and timed side by side. Anything else would compare two different compilations.
//
// THE RATIO IS THE MEASUREMENT, not the milliseconds: wall-clock depends on the machine, and what a regression
// breaks is the RELATIONSHIP. A generated reader within a small multiple of the hand-written one is a reader worth
// swapping in; one an order of magnitude slower is not.
//
// ON EVERY BACKEND, not one. A ratio measured on a JIT is a fact about that JIT: what a generated reader pays for
// is a task call per character where the hand-written one indexes a string, and what a task call COSTS is a
// property of the target. Each backend is skipped WITH A REASON when its toolchain is absent, never silently.
//
// Measured 2026-08-31, hex, 512 bytes of input x 200 runs, both readers in one compiled module:
//
//   backend      generated   hand-written   ratio
//   typescript      6.8ms          2.4ms     2.86
//   rust           73.5ms         29.2ms     2.51
//   swift        2526.2ms       1475.8ms     1.71
//   kotlin         14.6ms          9.3ms     1.58
//
// So the answer for format-mill-0007 is YES, everywhere: a generated reader costs under three times a
// hand-written one on the worst of the four, and under twice on the best, on a dialect whose hand-written reader
// is about as tight as one gets (a digit table and a two-nibble loop). The three ahead-of-time backends do BETTER
// than the JIT, which is worth knowing and is the opposite of what "the generated code is less idiomatic" would
// have you guess. What it buys is a reader that cannot disagree with the grammar it was generated from.
//
// The absolute numbers across backends are not comparable with each other — Swift is timing a debug-ish `-O`
// build of the whole stdlib closure and Rust is running an unoptimised cursor — and comparing them would be a
// mistake. Each ROW is a comparison; the column is not.
//
// Run: npx tsx test/compile/feed-mill-bench.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'
import {
  compileFeedMine,
  feedMineSubstrate,
  readFeedMineGrammar,
} from '@term/make/code/compile/feed-mill'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const PACKS: Record<string, string> = {
  seed: join(TERM, 'deck/seed'),
  feed: join(TERM, 'deck/feed'),
}

// the generated reader may be at most this many times slower than the hand-written one. Generous on purpose: what
// this catches is an order-of-magnitude regression, not a few percent of noise on a shared machine.
const LIMIT = 8

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info}` : ''}`)
  }
}

const resolver = (path: string, from: string): Source | undefined => {
  const match = /^@term\/([^/]+)\/(.+)$/.exec(path)
  const root = match ? PACKS[match[1]!] : undefined
  const rest = match?.[2]

  if (!root || !rest) {
    return undefined
  }

  for (const candidate of [
    join(root, `${rest}.tree`),
    join(root, rest, 'base.tree'),
  ]) {
    if (existsSync(candidate)) {
      return { file: candidate, text: readFileSync(candidate, 'utf8') }
    }
  }

  return undefined
}

const readRuntime = (p: string): string | undefined =>
  existsSync(p) ? readFileSync(p, 'utf8') : undefined

// is a toolchain on this machine? A missing one is a SKIP with the reason said out loud, never a silent pass:
// "no check fired on it" is not "someone verified it", and a native ratio nobody measured must not read as one
// that came back fine.
function have(tool: string): boolean {
  return spawnSync('which', [tool], { encoding: 'utf8' }).status === 0
}

// The same benchmark per backend: read both ways, agree, then time each. Written in each target's own words
// because there is no portable clock here, and kept deliberately identical in shape so the three numbers mean the
// same thing. The emitted task names are the backend's own casing of `run-generated` / `run-hand`.
const NATIVE = [
  {
    name: 'rust' as const,
    tool: 'rustc',
    ext: 'rs',
    emit: (program: Program) => emitRust(program),
    build: (src: string, exe: string) => ['-A', 'warnings', '-O', src, '-o', exe],
    // the reader can raise, so on Rust it comes back as a `Result`. Unwrapped here rather than handled: a
    // benchmark that swallowed a read failure would be timing the failure path.
    main: `fn main() {
    let input = "deadbeefcafef00d".repeat(64);
    let runs = 200;
    let a = run_generated(input.clone()).unwrap();
    let b = run_hand(input.clone()).unwrap();

    if a != b {
        println!("{{\\"agree\\":false,\\"a\\":{},\\"b\\":{}}}", a, b);
        return;
    }

    for _ in 0..20 { run_generated(input.clone()).unwrap(); run_hand(input.clone()).unwrap(); }

    let t0 = std::time::Instant::now();
    for _ in 0..runs { run_generated(input.clone()).unwrap(); }
    let g = t0.elapsed().as_secs_f64() * 1000.0;
    let t1 = std::time::Instant::now();
    for _ in 0..runs { run_hand(input.clone()).unwrap(); }
    let h = t1.elapsed().as_secs_f64() * 1000.0;

    println!("{{\\"agree\\":true,\\"bytes\\":{},\\"generated\\":{},\\"hand\\":{}}}", a, g, h);
}
`,
  },
  {
    name: 'swift' as const,
    tool: 'swiftc',
    ext: 'swift',
    emit: (program: Program) => emitSwift(program),
    build: (src: string, exe: string) => ['-O', '-suppress-warnings', src, '-o', exe],
    main: `let input = String(repeating: "deadbeefcafef00d", count: 64)
let runs = 200
let a = try! runGenerated(input)
let b = try! runHand(input)

if a != b {
    print("{\\"agree\\":false,\\"a\\":\\(a),\\"b\\":\\(b)}")
    exit(0)
}

for _ in 0..<20 { _ = try! runGenerated(input); _ = try! runHand(input) }

let t0 = Date()
for _ in 0..<runs { _ = try! runGenerated(input) }
let g = Date().timeIntervalSince(t0) * 1000
let t1 = Date()
for _ in 0..<runs { _ = try! runHand(input) }
let h = Date().timeIntervalSince(t1) * 1000

print("{\\"agree\\":true,\\"bytes\\":\\(a),\\"generated\\":\\(g),\\"hand\\":\\(h)}")
`,
  },
  {
    // kotlinc pays a JVM start of several seconds per invocation and produces a jar rather than an executable, so
    // this one is built and run through `java -jar`. `-include-runtime` is what makes the jar self-contained.
    name: 'kotlin' as const,
    tool: 'kotlinc',
    ext: 'kt',
    emit: (program: Program) => emitKotlin(program),
    build: (src: string, exe: string) => [src, '-include-runtime', '-d', `${exe}.jar`],
    run: (exe: string) => ({ command: 'java', args: ['-jar', `${exe}.jar`] }),
    main: `fun main() {
    val input = "deadbeefcafef00d".repeat(64)
    val runs = 200
    val a = runGenerated(input)
    val b = runHand(input)

    if (a != b) {
        println("{\\"agree\\":false,\\"a\\":$a,\\"b\\":$b}")
        return
    }

    for (i in 0 until 20) { runGenerated(input); runHand(input) }

    val t0 = System.nanoTime()
    for (i in 0 until runs) { runGenerated(input) }
    val g = (System.nanoTime() - t0) / 1e6
    val t1 = System.nanoTime()
    for (i in 0 until runs) { runHand(input) }
    val h = (System.nanoTime() - t1) / 1e6

    println("{\\"agree\\":true,\\"bytes\\":$a,\\"generated\\":$g,\\"hand\\":$h}")
}
`,
  },
]

// the same front end feed-mill-run uses, called the same way: its signatures are what they are, and a second
// spelling of them here would drift
function frontEnd(
  text: string,
  roots: string[],
  // the target this program is for. `withNativeEnv` rewrites every abstract `.../native/{platform}/...` import to
  // the concrete one, so a Rust build must be built AS a Rust build: compiling the node closure and handing it to
  // rustc is a different program.
  env: 'node' | 'rust' | 'swift' | 'kotlin' = 'node',
): Program {
  const sources = collectModules(
    { file: 'main.tree', text },
    withNativeEnv(env, resolver),
  ).sources
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(`mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`)
    }

    program.push(...built.program)
  }

  extendForms(program, 'main.tree')
  disambiguateOverloads(program)
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 8).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)
  simplify(program, new Set(roots))

  return program
}

// ---- hex: the dialect with both a generated and a hand-written reader ----

const mineFile = join(TERM, 'deck/feed/code/hex/mine.tree')
const mineParsed = parse({ file: mineFile, text: readFileSync(mineFile, 'utf8') })

ok('the hex grammar parses', mineParsed.ok)

if (!mineParsed.ok) {
  console.log(`\nfeed-mill-bench: ${pass} pass, ${fail} fail`)
  process.exit(1)
}

const grammar = readFeedMineGrammar(mineParsed.tree)
const substrate = feedMineSubstrate(grammar)

ok('the substrate infers as text', substrate === 'text', String(substrate))

const generated = compileFeedMine(grammar, substrate ?? 'text', '@term/feed/code/base', [
  'load @term/feed/code/hex/code',
  '  find hex-digit-value',
  '  find read-hex, name hand-read-hex',
  '',
])

// one entry per reader, over the same input
const entry = `${generated}
task run-generated
  take input, like text
  like number
  save cursor
    call make-text-cursor(read input)
  save bytes
    call read-hex(read cursor)
  send back
    call size(read bytes)

task run-hand
  take input, like text
  like number
  save bytes
    call hand-read-hex(read input)
  send back
    call size(read bytes)
`

try {
  const program = frontEnd(entry, ['run-generated', 'run-hand'])
  const ts = `${nativePrelude(program, 'node', readRuntime)}\n${emitTypeScript(program)}`

  ok('both readers compile into one module', true)

  // a real-looking input, repeated, so the measurement is not dominated by call overhead
  const main = `
const input = "deadbeefcafef00d".repeat(64)
const runs = 200

// both must agree before either is timed: a faster reader that reads something else is not a reader
const a = runGenerated(input)
const b = runHand(input)

if (a !== b) {
  console.log(JSON.stringify({ agree: false, a, b }))
  process.exit(0)
}

for (let i = 0; i < 20; i++) { runGenerated(input); runHand(input) }

const t0 = process.hrtime.bigint()
for (let i = 0; i < runs; i++) { runGenerated(input) }
const t1 = process.hrtime.bigint()
for (let i = 0; i < runs; i++) { runHand(input) }
const t2 = process.hrtime.bigint()

console.log(JSON.stringify({
  agree: true,
  bytes: a,
  generated: Number(t1 - t0) / 1e6,
  hand: Number(t2 - t1) / 1e6,
}))
`

  const dir = mkdtempSync(join(tmpdir(), 'feed-mill-bench-'))
  const file = join(dir, 'bench.ts')

  writeFileSync(file, `${ts}${main}`)

  const output = execFileSync('npx', ['tsx', file], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trim()
  const result = JSON.parse(output.split('\n').pop() ?? '{}') as {
    agree: boolean
    bytes?: number
    generated?: number
    hand?: number
  }

  ok('the two readers read the same bytes', result.agree === true, output)

  if (result.agree) {
    const ratio = (result.generated ?? 0) / Math.max(result.hand ?? 0, 0.001)

    console.log(
      `  ${result.bytes} bytes x 200 runs: generated ${result.generated?.toFixed(1)}ms, hand ${result.hand?.toFixed(1)}ms`,
    )

    ok(
      `the generated reader is within ${LIMIT}x the hand-written one (ratio ${ratio.toFixed(2)})`,
      ratio <= LIMIT,
      'a generated reader this much slower is not one worth swapping in',
    )
  }
  // ---- AND THE NATIVE BACKENDS ----
  //
  // A ratio measured on one backend is a fact about that backend. What the generated reader pays for is a task
  // call per character where the hand-written one indexes a string, and what a task call COSTS is entirely a
  // property of the target: a JIT inlines a small closure, and an ahead-of-time compiler with `-O` may do better
  // or worse. Assuming TypeScript's 2.86x carries over is exactly the guess this file exists not to make.
  //
  // Same program, same input, same two readers in one module, emitted per backend. Skipped with a reason when the
  // toolchain is absent, the way test/compile/roundtrip.ts gates its own native runs.
  for (const backend of NATIVE) {
    if (!have(backend.tool)) {
      console.log(`skip  ${backend.name}: ${backend.tool} not installed`)
      continue
    }

    const nativeProgram = frontEnd(entry, ['run-generated', 'run-hand'], backend.name)
    // the runtime shims for every global the program DOCKS, prepended, exactly as the TypeScript path does.
    // Without them the emitted source names modules that do not exist (`bit`, and whatever else the closure
    // reaches) and the toolchain refuses it.
    const source = `${nativePrelude(nativeProgram, backend.name, readRuntime)}\n${backend.emit(nativeProgram)}`
    const src = join(dir, `bench.${backend.ext}`)

    writeFileSync(src, `${source}\n${backend.main}`)

    const exe = join(dir, `bench-${backend.name}`)
    const built = spawnSync(backend.tool, backend.build(src, exe), { encoding: 'utf8' })

    if (built.status !== 0) {
      ok(`${backend.name}: both readers compile into one binary`, false, built.stderr ?? '')
      continue
    }

    ok(`${backend.name}: both readers compile into one binary`, true)

    const runner = backend.run ? backend.run(exe) : { command: exe, args: [] as string[] }
    const ran = spawnSync(runner.command, runner.args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    const line = (ran.stdout ?? '').trim().split('\n').pop() ?? '{}'

    let native: { agree?: boolean; bytes?: number; generated?: number; hand?: number }

    try {
      native = JSON.parse(line)
    } catch {
      ok(`${backend.name}: the benchmark reports its timings`, false, `${line}${ran.stderr ?? ''}`.slice(0, 300))
      continue
    }

    ok(`${backend.name}: the two readers read the same bytes`, native.agree === true, line)

    if (native.agree) {
      const ratio = (native.generated ?? 0) / Math.max(native.hand ?? 0, 0.001)

      console.log(
        `  ${backend.name}: ${native.bytes} bytes x 200 runs: generated ${native.generated?.toFixed(1)}ms, hand ${native.hand?.toFixed(1)}ms`,
      )

      ok(
        `${backend.name}: the generated reader is within ${LIMIT}x the hand-written one (ratio ${ratio.toFixed(2)})`,
        ratio <= LIMIT,
        'a generated reader this much slower is not one worth swapping in',
      )
    }
  }
} catch (error) {
  ok('both readers compile into one module', false, String((error as Error).message ?? error).slice(0, 300))
}

console.log(`\nfeed-mill-bench: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
