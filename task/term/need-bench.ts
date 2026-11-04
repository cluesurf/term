// What choosing a version costs a command (note/project/term/term-versions.md, "Dispatch", V5).
//
// Every `term` starts in host/need.mjs, which resolves a version and then imports host/line.js in the same process or
// hands over to another version. This times `term --version` four ways, each judged over --runs (40) starts:
//
//   bare        node host/line.js, no dispatch at all: the floor every other case is measured from
//   no request  node host/need.mjs, nothing anywhere asks for a version                     budget  5 ms over bare
//   satisfied   in a project whose deck.tree needs this version                            budget 15 ms over bare
//   handoff     in a project that needs ANOTHER version, installed: one more Node start    budget 150 ms over bare
//
// THE RELEASE PAYLOAD, not the dev build: `pnpm run release --dry` writes it, bundled as a
// person installs it. The dev build leaves its packages unbundled and starts several times slower, which says nothing
// about what dispatch costs a person.
//
// THE CASES ARE INTERLEAVED, one start of each per round, so a machine that is busy for part of the run slows every
// case alike rather than one of them.
//
// JUDGED ON THE FASTEST START, with the median printed beside it. A start cannot be faster than what it costs, so the
// minimum over many is the estimate that load cannot inflate, and this machine is shared: the first run on 2026-10-04
// met a load average of 64, under which `bare` took 607 ms against 130 ms idle. The load average is printed with
// every run, so a reader can see what the medians were measured under.
//
// Each case runs in a scratch HOME, so no installed version or default on this machine leaks in: an EMPTY one for the
// first three, since with nothing asked for, the newest version installed would win (rule 5). The handoff's home holds
// the other version: the same payload under code/<version>/ with its package.json saying so, as a release unpacks.
//
// Run from the repository root: `pnpm term:need-bench`. Writes nothing outside tmp/.

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, loadavg } from 'node:os'
import { join } from 'node:path'
import { TERM_ROOT } from './root'

// the Term package root: the alias runs this from there, as it runs cli-drift
const TERM = TERM_ROOT
const VERSION = (JSON.parse(readFileSync(join(TERM, 'package.json'), 'utf8')) as { version: string }).version
const OTHER = '99.0.0'
const RUNS = Number(argOf('--runs') ?? 40)
const PLATFORM = `${process.platform === 'win32' ? 'windows' : process.platform}-${process.arch}`
const PAYLOAD = join(TERM, 'tmp', 'release', VERSION, `term-${PLATFORM}.tar.gz`)

const BUDGETS = { 'no request': 5, satisfied: 15, handoff: 150 } as const

function argOf(name: string): string | undefined {
  const at = process.argv.indexOf(name)

  return at >= 0 ? process.argv[at + 1] : undefined
}

if (!existsSync(PAYLOAD)) {
  console.log(`need-bench: no ${PAYLOAD}; run pnpm run release --dry first`)
  process.exit(1)
}

const scratch = mkdtempSync(join(TERM, 'tmp', 'need-bench-'))
const empty = join(scratch, 'empty')
const home = join(scratch, 'home')
const base = join(home, '.base', '@term', 'code')
const outside = join(scratch, 'outside')
const satisfied = join(scratch, 'satisfied')
const handoff = join(scratch, 'handoff')

// this version, unpacked where a person's would be, and the other one beside it under the handoff's home
const here = join(scratch, 'payload')

mkdirSync(here, { recursive: true })
execFileSync('tar', ['-xzf', PAYLOAD, '-C', here])

const HOST = join(here, 'term', 'host')
const other = join(base, 'code', OTHER)

mkdirSync(other, { recursive: true })
execFileSync('tar', ['-xzf', PAYLOAD, '-C', other])
writeFileSync(join(other, 'term', 'package.json'), `${JSON.stringify({ name: '@cluesurf/term', version: OTHER, type: 'module', private: true })}\n`)
writeFileSync(join(other, 'install.tree'), `install\n  code <${OTHER}>\n  form <${PLATFORM}>\n  hash <sha256:${'0'.repeat(64)}>\n`)

for (const [dir, need] of [[outside, undefined], [satisfied, VERSION], [handoff, OTHER]] as const) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deck.tree'), `deck @bench/app\n  mark <1.0.0>\n${need ? `  need @term/code, mark <${need}>\n` : ''}`)
}

mkdirSync(empty, { recursive: true })

// no request may come from the shell running the bench, and nothing may be downloaded
function envOf(at: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: at, TERM_NEED: 'local' }

  delete env['TERM_VERSION']

  return env
}

const cases = [
  { name: 'bare', entry: join(HOST, 'line.js'), cwd: outside, expect: VERSION, env: envOf(empty), times: [] as number[] },
  { name: 'no request', entry: join(HOST, 'need.mjs'), cwd: outside, expect: VERSION, env: envOf(empty), times: [] as number[] },
  { name: 'satisfied', entry: join(HOST, 'need.mjs'), cwd: satisfied, expect: VERSION, env: envOf(empty), times: [] as number[] },
  { name: 'handoff', entry: join(HOST, 'need.mjs'), cwd: handoff, expect: OTHER, env: envOf(home), times: [] as number[] },
] as const

// one round first, unmeasured, so the disk cache is warm for every case
for (let round = 0; round <= RUNS; round++) {
  for (const one of cases) {
    const started = process.hrtime.bigint()
    const done = spawnSync(process.execPath, [one.entry, '--version'], { cwd: one.cwd, env: one.env, encoding: 'utf8' })
    const took = Number(process.hrtime.bigint() - started) / 1e6

    if (done.stdout.trim() !== one.expect) {
      throw new Error(`${one.name}: printed ${JSON.stringify(done.stdout + done.stderr)}, not ${one.expect}`)
    }

    if (round > 0) {
      one.times.push(took)
    }
  }
}

function median(times: number[]): number {
  const sorted = [...times].sort((a, b) => a - b)

  return sorted[Math.floor(sorted.length / 2)]!
}

function fastest(times: number[]): number {
  return Math.min(...times)
}

const machine = execFileSync(process.platform === 'darwin' ? 'sysctl' : 'uname', process.platform === 'darwin' ? ['-n', 'machdep.cpu.brand_string'] : ['-m'], { encoding: 'utf8' }).trim()
const floor = fastest(cases[0].times)
const load = loadavg()[0]!.toFixed(1)

console.log(`term need-bench: term ${VERSION} release payload, node ${process.version}, ${machine}, ${RUNS} starts each`)
console.log(`  load average ${load} on ${cpus().length} cores`)
console.log(`  bare        fastest ${floor.toFixed(1)} ms, median ${median(cases[0].times).toFixed(1)} ms  node host/line.js --version`)

let over = 0

for (const one of cases.slice(1)) {
  const ms = fastest(one.times)
  const added = ms - floor
  const budget = BUDGETS[one.name as keyof typeof BUDGETS]
  const within = added <= budget

  if (!within) {
    over++
  }

  console.log(`  ${one.name.padEnd(10)}  fastest ${ms.toFixed(1)} ms, median ${median(one.times).toFixed(1)} ms  ${added >= 0 ? '+' : ''}${added.toFixed(1)} ms over bare, budget ${budget} ms  ${within ? 'ok' : 'OVER'}`)
}

console.log(`\nterm need-bench: ${cases.length - 1 - over} of ${cases.length - 1} within budget`)

if (over > 0) {
  process.exit(1)
}
