// How long `term` takes to start, per invocation, against the budget in note/project/term/self-host/07-the-binary.md.
//
// THE NUMBER THIS EXISTS FOR. The native binary is meant to answer `--help` in under 10 ms, and that is a measurement
// or it is a hope. Measured on 2026-10-02 the node build took 150 to 180 ms for the same answer, about 120 ms of it
// spent loading host/line.js before any work started. This records that baseline now, so every later phase (the split
// bundle in P1, the native binary in P10) is held against a number taken before it, not against memory.
//
// WHAT IT TIMES. Wall clock from spawn to exit, which is what a person waiting at a prompt feels. Each invocation runs
// twice to warm the file cache and then RUNS times, and the median and the 95th percentile are reported. A minimum is
// not reported: it is the number most flattering to a regression.
//
// WHAT IT RUNS. By default the shipped node build (`node host/line.js`). `--bin <path>` times a native binary instead,
// and then the budget is enforced: a median or p95 over budget fails. The node build has no budget, because it is the
// baseline the budget is measured against.
//
// `--make` adds a no-op `term make --trees` on the stdlib, five runs. It is off by default because the first run of it
// may be a real build. `--commit` writes the result to note/project/term/self-host/startup.json, and `--note <text>` writes
// the conditions of the run beside it (quiet machine, on battery, under load).
//
//   pnpm term:startup
//   pnpm term:startup --bin /path/to/term
//   pnpm term:startup --make --commit

import { spawnSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { TERM_ROOT, parentRoot } from './root'

// run from the repository root, the way `pnpm term:startup` runs it
const HOME = TERM_ROOT
const TERM = TERM_ROOT
const BASE = join(TERM, 'deck/base')
const OUT = (): string => join(parentRoot(), 'note/project/term/self-host/startup.json')

const argv = process.argv.slice(2)
const binAt = argv.indexOf('--bin')
const bin = binAt >= 0 ? argv[binAt + 1] : undefined
const withMake = argv.includes('--make')
const commit = argv.includes('--commit')
// the conditions of the run, written into the record: a number taken under load is not a baseline
const noteAt = argv.indexOf('--note')
const note = noteAt >= 0 ? argv[noteAt + 1] : undefined

const RUNS = 20
const WARM = 2

type Case = {
  name: string
  args: string[]
  cwd: string
  runs: number
  // median and p95 budgets in ms, enforced only on a native binary
  budget: [number, number]
}

const CASES: Case[] = [
  { name: '--version', args: ['--version'], cwd: TERM, runs: RUNS, budget: [3, 5] },
  { name: '--help', args: ['--help'], cwd: TERM, runs: RUNS, budget: [5, 10] },
  { name: 'make --help', args: ['make', '--help'], cwd: TERM, runs: RUNS, budget: [5, 10] },
  { name: 'unknown verb', args: ['nonesuch'], cwd: TERM, runs: RUNS, budget: [5, 10] },
  // compiler-free: prints the shell completion script and touches no project
  { name: 'fill', args: ['fill'], cwd: TERM, runs: RUNS, budget: [10, 15] },
]

if (withMake) {
  CASES.push({
    name: 'make, stdlib, no change',
    args: ['make', '--trees'],
    cwd: BASE,
    runs: 5,
    budget: [50, 80],
  })
}

function command(args: string[]): [string, string[]] {
  return bin ? [bin, args] : [process.execPath, [join(TERM, 'host/line.js'), ...args]]
}

function once(c: Case): number {
  const [file, args] = command(c.args)
  const start = process.hrtime.bigint()

  spawnSync(file, args, { cwd: c.cwd, stdio: 'ignore' })

  return Number(process.hrtime.bigint() - start) / 1e6
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)]
}

type Row = { name: string; median: number; p95: number; runs: number; budget: [number, number]; over: boolean }

function main(): void {
  const rows: Row[] = []

  console.log(`term startup: ${bin ? bin : `node ${process.version}, host/line.js`}`)
  console.log('')

  for (const c of CASES) {
    for (let i = 0; i < WARM; i++) {
      once(c)
    }

    const times: number[] = []

    for (let i = 0; i < c.runs; i++) {
      times.push(once(c))
    }

    times.sort((a, b) => a - b)

    const median = percentile(times, 50)
    const p95 = percentile(times, 95)
    const over = bin !== undefined && (median > c.budget[0] || p95 > c.budget[1])

    rows.push({ name: c.name, median, p95, runs: c.runs, budget: c.budget, over })

    const mark = bin === undefined ? '    ' : over ? 'OVER' : 'ok  '

    console.log(
      `  ${mark} ${c.name.padEnd(26)} median ${median.toFixed(1).padStart(7)} ms   p95 ${p95
        .toFixed(1)
        .padStart(7)} ms   budget ${c.budget[0]} / ${c.budget[1]} ms`,
    )
  }

  const over = rows.filter(row => row.over).length

  console.log('')
  console.log(
    bin === undefined
      ? 'term startup: node baseline, no budget enforced'
      : `term startup: ${rows.length - over} within budget, ${over} over`,
  )

  if (commit) {
    const record = {
      taken: new Date().toISOString().slice(0, 10),
      ...(note ? { note } : {}),
      subject: bin ?? `node ${process.version} host/line.js`,
      platform: `${process.platform}-${process.arch}`,
      row: rows.map(({ name, median, p95, runs, budget }) => ({
        name,
        median: Number(median.toFixed(1)),
        p95: Number(p95.toFixed(1)),
        runs,
        budget,
      })),
    }

    writeFileSync(OUT(), `${JSON.stringify(record, null, 2)}\n`)
    console.log(`wrote ${OUT()}`)
  }

  if (over > 0) {
    process.exitCode = 1
  }
}

main()
