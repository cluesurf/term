// The sorted map's B-tree against Rust's own `BTreeMap`, on Rust, at several minimum degrees
// (note/project/term/decisions-2026-10/decisions-2026-10.md, D8: choose the degree by measurement, not convention).
//
//   pnpm term:sorted-map-bench                  degrees 4, 8, 16, 32, 64
//   pnpm term:sorted-map-bench --degrees 8,16   those alone
//   pnpm term:sorted-map-bench --operations N   seeded puts and drops (default 1,000,000), over a tenth as many keys
//   pnpm term:sorted-map-bench --typescript     also the same tree on node, at each degree
//
// Each degree builds the same Term program over a COPY of deck/base/code/sorted-map.tree whose one change is its
// `host degree` line, loaded by a relative path, so the stdlib's own file is never touched. Two hand-written Rust
// programs do the same seeded work: `BTreeMap<i64, i64>` ordered by the key's `Ord`, and one ordered by a comparator
// closure behind an `Rc`, which is the fair comparison, because the Term map's order is a task chosen at run time.
// Every program prints its length and the sum of a lookup of every key, and a run that disagrees with the first
// fails the bench. Everything is built with `rustc -O` and timed as the median of five runs, wall clock.
//
// Run from the Term root, where the `@term/*` paths resolve.

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { nativeMain } from '@term/make/code/compile/native-main'
import { projectResolver } from '@term/call/code/make'
import { TERM_ROOT } from './root'

const TERM = TERM_ROOT
const argument = (flag: string): string | undefined => {
  const at = process.argv.indexOf(flag)

  return at >= 0 ? process.argv[at + 1] : undefined
}

const DEGREES = (argument('--degrees') ?? '4,8,16,32,64').split(',').map(Number)
const OPERATIONS = Number(argument('--operations') ?? 1_000_000)
const KEYS = Math.max(1, Math.floor(OPERATIONS / 10))
const RUNS = 5
const TYPESCRIPT = process.argv.includes('--typescript')

const readRuntime = (file: string): string | undefined => {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

const PROGRAM = `load ./sorted-map
  find sorted-map
  find make-sorted-map

load @term/base/ordering
  find from-numbers

load @term/base/maybe
  find unwrap-or

task run
  like text
  save m, make-sorted-map(from-numbers)
  save state, 12345
  save i, 0
  walk test
    hook test, is-below(i, ${OPERATIONS})
    hold
      save state, modulo(multiply(state, 48271), 2147483647)
      save key, modulo(state, ${KEYS})
      save state, modulo(multiply(state, 48271), 2147483647)
      fork test, is-below(modulo(state, 3), 2)
        hold
          put(m, key, multiply(key, 7))
        miss
          drop(m, key)
      save i, add(i, 1)
  save total, 0
  save j, 0
  walk test
    hook test, is-below(j, ${KEYS})
    hold
      save total, add(total, unwrap-or(lookup(m, j), 0))
      save j, add(j, 1)
  back <{length(m)}|{total}>
`

// the same work in Rust, ordered by the key's `Ord` or by a comparator closure
const rustBaseline = (byClosure: boolean): string => `use std::collections::BTreeMap;
${
  byClosure
    ? `use std::cmp::Ordering;
use std::rc::Rc;

#[derive(Clone)]
struct Key { value: i64, order: Rc<dyn Fn(i64, i64) -> Ordering> }
impl PartialEq for Key { fn eq(&self, other: &Self) -> bool { (self.order)(self.value, other.value) == Ordering::Equal } }
impl Eq for Key {}
impl PartialOrd for Key { fn partial_cmp(&self, other: &Self) -> Option<Ordering> { Some(self.cmp(other)) } }
impl Ord for Key { fn cmp(&self, other: &Self) -> Ordering { (self.order)(self.value, other.value) } }
`
    : ''
}
fn main() {
${byClosure ? '    let order: Rc<dyn Fn(i64, i64) -> Ordering> = Rc::new(|a: i64, b: i64| a.cmp(&b));\n    let key = |value: i64| Key { value, order: order.clone() };\n' : '    let key = |value: i64| value;\n'}    let mut m = BTreeMap::new();
    let mut state: i64 = 12345;
    for _ in 0..${OPERATIONS} {
        state = state * 48271 % 2147483647;
        let k = state % ${KEYS};
        state = state * 48271 % 2147483647;
        if state % 3 < 2 { m.insert(key(k), k * 7); } else { m.remove(&key(k)); }
    }
    let mut total: i64 = 0;
    for j in 0..${KEYS} { total += *m.get(&key(j)).unwrap_or(&0); }
    print!("{}|{}", m.len(), total);
}
`

function rustc(source: string, stem: string): string {
  writeFileSync(`${stem}.rs`, source)
  execFileSync('rustc', ['-O', '--edition', '2021', '-A', 'warnings', '-o', stem, `${stem}.rs`], { stdio: 'pipe' })

  return stem
}

// the Term program over a copy of the B-tree at `degree`, built for Rust or for node, as the command that runs it.
// TypeScript is turned into plain JavaScript by esbuild first, so the timing is the program's and not tsx's compile
function termBuild(degree: number, backend: 'rust' | 'typescript'): string[] {
  const tree = readFileSync(join(TERM, 'deck/base/code/sorted-map.tree'), 'utf8')
  const copy = tree.replace(/^host degree, \d+$/m, `host degree, ${degree}`)

  if (copy === tree && degree !== 16) {
    throw new Error('sorted-map.tree has no `host degree, N` line to change')
  }

  // inside the project, which is where its resolver reads a relative load
  mkdirSync(join(TERM, 'tmp'), { recursive: true })
  const folder = mkdtempSync(join(TERM, 'tmp', `sorted-map-degree-${degree}-`))
  writeFileSync(join(folder, 'sorted-map.tree'), copy)
  const file = join(folder, 'bench.tree')
  writeFileSync(file, PROGRAM)
  const env = backend === 'rust' ? 'rust' : 'node'
  const result = compile({ file, text: PROGRAM }, { resolve: projectResolver(TERM, env), env })

  if (!result.ok) {
    throw new Error(`degree ${degree} does not compile: ${result.diagnostics.map(d => d.message).slice(0, 4).join(' | ')}`)
  }

  if (backend === 'typescript') {
    const source = `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nprocess.stdout.write(String(run()))\n`
    const script = join(folder, 'bench.mjs')
    writeFileSync(script, transformSync(source, { loader: 'ts', format: 'esm' }).code)

    return [process.execPath, script]
  }

  const rust = emitRust(result.program)

  return [rustc([nativePrelude(result.program, 'rust', readRuntime, rust), rust, nativeMain('rust', rust), ''].join('\n'), join(folder, 'bench'))]
}

// the median of RUNS wall-clock runs, and what the program printed
function time(command: string[]): { ms: number; output: string } {
  const times: number[] = []
  let output = ''

  for (let run = 0; run < RUNS; run++) {
    const start = process.hrtime.bigint()
    const ran = spawnSync(command[0]!, command.slice(1), { encoding: 'utf8', maxBuffer: 1 << 26 })
    times.push(Number(process.hrtime.bigint() - start) / 1e6)

    if (ran.status !== 0) {
      throw new Error(`${command.join(' ')} exited ${ran.status}: ${String(ran.stderr).slice(0, 400)}`)
    }

    output = ran.stdout
  }

  times.sort((a, b) => a - b)

  return { ms: times[Math.floor(RUNS / 2)]!, output }
}

const dir = mkdtempSync(join(tmpdir(), 'term-sorted-map-bench-'))
const rows: { name: string; ms: number; output: string }[] = []

rows.push({ name: 'BTreeMap, by Ord', ...time([rustc(rustBaseline(false), join(dir, 'btree-ord'))]) })
rows.push({ name: 'BTreeMap, by a closure', ...time([rustc(rustBaseline(true), join(dir, 'btree-closure'))]) })

for (const degree of DEGREES) {
  rows.push({ name: `Term B-tree, degree ${degree}`, ...time(termBuild(degree, 'rust')) })
}

// the same tree on node, which has no ordered map of its own to compare with: the degrees against each other
if (TYPESCRIPT) {
  for (const degree of DEGREES) {
    rows.push({ name: `on node, degree ${degree}`, ...time(termBuild(degree, 'typescript')) })
  }
}

const reference = rows[0]!.output
const closure = rows[1]!.ms
let wrong = 0

console.log(`sorted-map-bench: ${OPERATIONS.toLocaleString('en-US')} seeded puts and drops over ${KEYS.toLocaleString('en-US')} keys, then a lookup of each; rustc -O, median of ${RUNS}\n`)

for (const row of rows) {
  const agrees = row.output === reference
  wrong += agrees ? 0 : 1
  console.log(
    `  ${row.name.padEnd(26)} ${row.ms.toFixed(1).padStart(9)} ms  ${(row.ms / closure).toFixed(2).padStart(6)}x the closure BTreeMap${agrees ? '' : `  DISAGREES: ${row.output} where ${reference}`}`,
  )
}

console.log(`\nanswer: ${reference}`)

if (wrong > 0) {
  process.exit(1)
}
