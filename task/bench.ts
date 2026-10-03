// pnpm term:bench: every program under bench/, built from Term and by hand on each installed target, checked for the
// expected output, then timed in shuffled rounds. The number reported is the ratio of the medians, Term over the hand
// version, with a 95% bootstrap interval over the rounds (note/term/codegen/measurement.md). Reports by default, and
// writes bench/<program>/results/<machine>.json only on --commit.
//
//   pnpm term:bench                          every program, every target
//   pnpm term:bench --only fannkuch-redux    one program
//   pnpm term:bench --target rust --size 11 --runs 9
//
// Release builds on both sides, with the same flags: rustc opt-level 3 with one codegen unit and panic=abort, swiftc
// -O -wmo with exclusivity unchecked (cask's release build), esbuild to node20 (minified) on the pinned node, kotlinc to
// a jar on the pinned JVM. A process is timed
// from spawn to exit, so startup is in both columns alike.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, hostname, platform } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { readDataText, toJsonValue } from '@term/make/code/compile/host'

type Target = 'typescript' | 'rust' | 'swift' | 'kotlin'
// `dir` is the program's directory, `hand` the stem of its hand-written versions (`idiom` here, `same` in mark/kernels)
type Spec = { dir: string; program: string; entry: string; check: number; expect: string; size: number; runs: number; hand: string }
type Built = { run: (n: number) => string[] }

const TERM = join(import.meta.dirname, '..')
const BENCH = join(TERM, 'bench')
const WORK = join(TERM, 'tmp', 'bench')
const argv = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = argv.indexOf(`--${name}`)

  return at >= 0 ? argv[at + 1] : undefined
}
const commit = argv.includes('--commit')
const TARGETS: Target[] = ['typescript', 'rust', 'swift', 'kotlin']
const TOOLS: Record<Target, string[]> = { typescript: ['node'], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }
const have = (tool: string): boolean => spawnSync('which', [tool]).status === 0
const RUST_FLAGS = ['-A', 'warnings', '-C', 'opt-level=3', '-C', 'codegen-units=1', '-C', 'panic=abort']
// the release build cask ships (cask.ts), on both sides
const SWIFT_FLAGS = ['-O', '-wmo', '-enforce-exclusivity=unchecked']

const base = join(TERM, 'deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)
const camel = (name: string): string => name.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())
const snake = (name: string): string => name.replace(/-/g, '_')
const normal = (text: string): string => text.trim().split(/\s+/).join(' ')

function spec(dir: string): Spec {
  const file = join(dir, 'bench.tree')
  const read = readDataText({ file, text: readFileSync(file, 'utf8') })

  if (!read.ok) {
    throw new Error(`${file}: ${read.diagnostics.map(d => d.message).join(' | ')}`)
  }

  const value = toJsonValue(read.data.root) as Record<string, unknown>

  // a kernel of the suite (mark/kernels, note/term/bench/rules.md): its entry is `run`, its sizes and expected output
  // are the contract's own, and its hand versions are `same.*`
  if (value.input) {
    const sizes = (value.input as { sizes: { check: number; timed: number } }).sizes

    return {
      dir,
      program: dir.split('/').at(-1)!,
      entry: 'run',
      check: Number(sizes.check),
      expect: normal(readFileSync(join(dir, 'expect/check.txt'), 'utf8')),
      size: Number(flag('size') ?? sizes.timed),
      runs: Number(flag('runs') ?? 5),
      hand: 'same',
    }
  }

  return {
    dir,
    program: String(value.program),
    entry: String(value.entry),
    check: Number(value.check),
    expect: normal(String(value.expect)),
    size: Number(flag('size') ?? value.size),
    runs: Number(flag('runs') ?? value.runs ?? 5),
    hand: 'idiom',
  }
}

// the Term program for one target, built into an executable
function buildTerm(s: Spec, target: Target, out: string): Built {
  const file = join(s.dir, 'term.tree')
  const env = target === 'typescript' ? 'node' : target
  const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv(env, stdlib), env })

  if (!built.ok) {
    throw new Error(built.diagnostics.map(d => d.message).join(' | '))
  }

  const prelude = nativePrelude(built.program, env as never, readRuntime)

  if (target === 'typescript') {
    writeFileSync(join(out, 'term.ts'), `${prelude}\n${built.typescript}\nconsole.log(${camel(s.entry)}(Number(process.argv[2])))\n`)
    buildSync({ entryPoints: [join(out, 'term.ts')], outfile: join(out, 'term.mjs'), bundle: true, minify: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'error' })

    return { run: n => ['node', join(out, 'term.mjs'), String(n)] }
  }

  if (target === 'rust') {
    writeFileSync(join(out, 'term.rs'), `${prelude}\n${emitRust(built.program)}\nfn main() { let n: i64 = std::env::args().nth(1).unwrap().parse().unwrap(); println!("{}", ${snake(s.entry)}(n)); }\n`)
    execFileSync('rustc', [...RUST_FLAGS, join(out, 'term.rs'), '-o', join(out, 'term-rs')], { stdio: ['ignore', 'pipe', 'pipe'] })

    return { run: n => [join(out, 'term-rs'), String(n)] }
  }

  if (target === 'swift') {
    writeFileSync(join(out, 'term.swift'), `${prelude}\n${emitSwift(built.program)}\nprint(${camel(s.entry)}(Int(CommandLine.arguments[1])!))\n`)
    execFileSync('swiftc', [...SWIFT_FLAGS, '-o', join(out, 'term-swift'), join(out, 'term.swift')], { stdio: ['ignore', 'pipe', 'pipe'] })

    return { run: n => [join(out, 'term-swift'), String(n)] }
  }

  writeFileSync(join(out, 'term.kt'), hoistKotlinImports(`${prelude}\n${emitKotlin(built.program)}\nfun main(args: Array<String>) { println(${camel(s.entry)}(args[0].toLong())) }\n`))
  execFileSync('kotlinc', [join(out, 'term.kt'), '-nowarn', '-include-runtime', '-d', join(out, 'term.jar')], { stdio: ['ignore', 'pipe', 'pipe'] })

  return { run: n => ['java', '-jar', join(out, 'term.jar'), String(n)] }
}

// the hand-written version for one target
function buildIdiom(s: Spec, target: Target, out: string): Built | undefined {
  const ext = { typescript: 'ts', rust: 'rs', swift: 'swift', kotlin: 'kt' }[target]
  const file = join(s.dir, `${s.hand}.${ext}`)

  if (!existsSync(file)) {
    return undefined
  }

  if (target === 'typescript') {
    buildSync({ entryPoints: [file], outfile: join(out, 'idiom.mjs'), bundle: true, minify: true, platform: 'node', target: 'node20', format: 'esm', logLevel: 'error' })

    return { run: n => ['node', join(out, 'idiom.mjs'), String(n)] }
  }

  if (target === 'rust') {
    execFileSync('rustc', [...RUST_FLAGS, file, '-o', join(out, 'idiom-rs')], { stdio: ['ignore', 'pipe', 'pipe'] })

    return { run: n => [join(out, 'idiom-rs'), String(n)] }
  }

  if (target === 'swift') {
    execFileSync('swiftc', [...SWIFT_FLAGS, '-o', join(out, 'idiom-swift'), file], { stdio: ['ignore', 'pipe', 'pipe'] })

    return { run: n => [join(out, 'idiom-swift'), String(n)] }
  }

  execFileSync('kotlinc', [file, '-nowarn', '-include-runtime', '-d', join(out, 'idiom.jar')], { stdio: ['ignore', 'pipe', 'pipe'] })

  return { run: n => ['java', '-jar', join(out, 'idiom.jar'), String(n)] }
}

function output(command: string[]): string {
  return normal(execFileSync(command[0]!, command.slice(1), { maxBuffer: 1 << 28 }).toString())
}

function time(command: string[]): number {
  const start = performance.now()
  const ran = spawnSync(command[0]!, command.slice(1), { stdio: 'ignore' })

  if (ran.status !== 0) {
    throw new Error(`${command.join(' ')} exited ${ran.status}`)
  }

  return performance.now() - start
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b)
  const m = s.length >> 1

  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2
}

// a 95% interval on median(term) / median(idiom), resampling the rounds with replacement
function interval(term: number[], idiom: number[]): [number, number] {
  let seed = 12345
  const random = (): number => {
    seed = (seed * 1103515245 + 12345) % 2147483648

    return seed / 2147483648
  }
  const ratios: number[] = []

  for (let b = 0; b < 2000; b++) {
    const pick = term.map(() => Math.floor(random() * term.length))
    ratios.push(median(pick.map(i => term[i]!)) / median(pick.map(i => idiom[i]!)))
  }

  ratios.sort((a, b) => a - b)

  return [ratios[Math.floor(ratios.length * 0.025)]!, ratios[Math.floor(ratios.length * 0.975)]!]
}

// `--kernels` reads the suite's kernels (mark/kernels) instead of bench/, the two overlapping in three programs
const KERNELS = join(TERM, 'mark', 'kernels')
const root = argv.includes('--kernels') ? KERNELS : BENCH
const programs = readdirSync(root).filter(name => existsSync(join(root, name, 'bench.tree')) && (!flag('only') || name === flag('only')))
const targets = TARGETS.filter(t => !flag('target') || t === flag('target'))
const machine = `${platform()}-${(cpus()[0]?.model ?? 'cpu').replace(/[^A-Za-z0-9]+/g, '-').toLowerCase()}`
let failed = 0

for (const program of programs) {
  const s = spec(join(root, program))
  const results: Record<string, unknown> = {}
  console.log(`\n${program}, n = ${s.size}, ${s.runs} rounds, ${machine}`)

  for (const target of targets) {
    if (TOOLS[target].some(tool => !have(tool))) {
      console.log(`  ${target.padEnd(11)} skipped: ${TOOLS[target].join(', ')} not installed`)
      continue
    }

    const out = join(WORK, program, target)
    mkdirSync(out, { recursive: true })

    let term: Built
    let idiom: Built | undefined

    try {
      term = buildTerm(s, target, out)
      idiom = buildIdiom(s, target, out)
    } catch (error) {
      failed++
      console.log(`  ${target.padEnd(11)} BUILD FAILED  ${String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 300)}`)
      continue
    }

    // the answer first: a fast wrong program never gets a time
    const answers = [['term', term], ['idiom', idiom]] as const
    let wrong = false

    for (const [side, built] of answers) {
      if (!built) continue
      const got = output(built.run(s.check))

      if (got !== s.expect) {
        wrong = true
        console.log(`  ${target.padEnd(11)} WRONG ANSWER from ${side}: ${JSON.stringify(got)}, want ${JSON.stringify(s.expect)}`)
      }
    }

    if (wrong) {
      failed++
      continue
    }

    // one untimed warm run of each, then the rounds in a shuffled order per round
    time(term.run(s.size))
    if (idiom) time(idiom.run(s.size))

    const termTimes: number[] = []
    const idiomTimes: number[] = []

    for (let round = 0; round < s.runs; round++) {
      const order = idiom ? (Math.random() < 0.5 ? ['term', 'idiom'] : ['idiom', 'term']) : ['term']

      for (const side of order) {
        if (side === 'term') termTimes.push(time(term.run(s.size)))
        else idiomTimes.push(time(idiom!.run(s.size)))
      }
    }

    const t = median(termTimes)

    if (!idiom) {
      console.log(`  ${target.padEnd(11)} term ${t.toFixed(0).padStart(7)} ms   (no hand version)`)
      results[target] = { term: termTimes }
      continue
    }

    const h = median(idiomTimes)
    const [low, high] = interval(termTimes, idiomTimes)
    console.log(`  ${target.padEnd(11)} term ${t.toFixed(0).padStart(7)} ms   idiom ${h.toFixed(0).padStart(7)} ms   ratio ${(t / h).toFixed(2)}  (${low.toFixed(2)} to ${high.toFixed(2)})`)
    results[target] = { term: termTimes, idiom: idiomTimes, ratio: t / h, interval: [low, high] }
  }

  if (commit) {
    const dir = join(BENCH, program, 'results')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, `${machine}.json`), JSON.stringify({ program, size: s.size, runs: s.runs, machine, host: hostname(), date: new Date().toISOString().slice(0, 10), results }, null, 2) + '\n')
    console.log(`  wrote ${join('bench', program, 'results', `${machine}.json`)}`)
  }
}

if (failed > 0) {
  process.exit(1)
}
