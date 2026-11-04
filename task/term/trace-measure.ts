// THE TRACE MEASUREMENT (`pnpm term:trace-measure`, decision 103 item 6 of
// note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0415).
//
// A stub carries a one-statement task's shape (`stubShape`) and a proven-pure task's body (`stubBody`) to every unit
// that names it, so today an edit to either rebuilds every naming unit. Decision 103 records, per unit built, which of
// those carried shapes and bodies a prover table or the kernel CONSULTED (compile/separate.ts, the trace). Keying a unit
// by its trace (item 0526) pays only when the units whose trace holds a carried task are much fewer than the units that
// name it. This counts both, per carried task, on a cold build of each corpus, and sums them per corpus.
//
// The gate (decision 103 item 6): traced units under 75% of naming units, summed over @term/base, and item 0526 builds
// the traced store keys. At 75% or more, 0526 is rejected with this measurement and decision 077 section 8 drops to a
// body-only cutoff.
//
// How: each corpus copied under the system temporary directory and built by `term make` in a fresh process on an
// empty TERM_CACHE_HOME, with TERM_TRACE_SINK naming a file every unit built appends `{files, carried, traced}` to
// (from the main thread or a pool worker alike). A unit built twice under one key (the same three lists) is counted
// once; under proof, the bodies key of decision 093, it is a unit of its own.
//
//   pnpm term:trace-measure                 zone, host and base, the table and the verdict
//   pnpm term:trace-measure --only zone     one corpus
//   pnpm term:trace-measure --top 10        and each corpus's ten most named carried tasks
//   pnpm term:trace-measure --verify trace  the builds under the trace check, which a missed consult fails
//
// Run from the Term root (the root script does), where host/line.js resolves. Writes only under the system
// temporary directory.

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { PARENT_ROOT, TERM_ROOT, parentPaths } from './root'

const TERM = TERM_ROOT
const REPO = TERM_ROOT
const LINE = path.join(TERM, 'host', 'line.js')
const GATE = 0.75

type Corpus = { name: string; from: string; stdlib: boolean }

const CORPORA: Corpus[] = [
  ...(PARENT_ROOT ? [{ name: 'zone', from: parentPaths('deck/zone')[0]!, stdlib: false }] : []),
  { name: 'host', from: 'deck/host', stdlib: false },
  { name: 'base', from: 'deck/base', stdlib: true },
]

const args = process.argv.slice(2)
const flag = (name: string): string | undefined => {
  const at = args.indexOf(`--${name}`)

  return at >= 0 ? args[at + 1] : undefined
}
const only = (flag('only') ?? '').split(',').filter(Boolean)
const top = Number(flag('top') ?? 0)
// `--verify trace`: TERM_CACHE_VERIFY for the builds, so a consult the trace missed fails the build it would have
// understated (decision 103 item 5)
const verify = flag('verify')

type Unit = { files: string[]; carried: string[]; traced: string[] }

type Count = { tasks: number; naming: number; tracing: number }

type Measured = {
  corpus: string
  units: number
  exit: number
  shape: Count
  body: Count
  all: Count
  most: { locator: string; naming: number; tracing: number }[]
}

// a copy of the package, as incremental-bench.ts makes one: the standard library's copy built AS the standard library
// (TERM_STDLIB), at <dir>/deck/base beside a host/ holding the worker bundles the CLI finds two folders above it
function copyOf(corpus: Corpus): string {
  const into = realpathSync(mkdtempSync(path.join(tmpdir(), `trace-measure-${corpus.name}-`)))
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
    if (existsSync(path.join(source, part))) cpSync(path.join(source, part), path.join(at, part), { recursive: true })
  }

  return realpathSync(at)
}

function measure(corpus: Corpus): Measured {
  const root = copyOf(corpus)
  const home = realpathSync(mkdtempSync(path.join(tmpdir(), `trace-measure-${corpus.name}-home-`)))
  const sink = path.join(home, 'trace.jsonl')
  const ran = spawnSync(process.execPath, [LINE, 'make', ...(corpus.stdlib ? ['--trees'] : [])], {
    cwd: root,
    env: {
      ...process.env,
      TERM_CACHE_HOME: home,
      TERM_TRACE_SINK: sink,
      ...(verify !== undefined ? { TERM_CACHE_VERIFY: verify } : {}),
      ...(corpus.stdlib ? { TERM_STDLIB: root } : {}),
    },
    encoding: 'utf8',
    maxBuffer: 1 << 28,
  })
  const lines = existsSync(sink) ? readFileSync(sink, 'utf8').split('\n').filter(Boolean) : []
  const units = [...new Set(lines)].map(line => JSON.parse(line) as Unit)
  const naming = new Map<string, number>()
  const tracing = new Map<string, number>()

  for (const unit of units) {
    const carried = new Set(unit.carried)

    for (const locator of carried) naming.set(locator, (naming.get(locator) ?? 0) + 1)

    for (const locator of new Set(unit.traced)) {
      if (carried.has(locator)) tracing.set(locator, (tracing.get(locator) ?? 0) + 1)
    }
  }

  const countOf = (kind: string): Count => {
    const locators = [...naming.keys()].filter(locator => kind === '' || locator.endsWith(`#${kind}`))

    return {
      tasks: locators.length,
      naming: locators.reduce((sum, locator) => sum + naming.get(locator)!, 0),
      tracing: locators.reduce((sum, locator) => sum + (tracing.get(locator) ?? 0), 0),
    }
  }

  const most = [...naming.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, top)
    .map(([locator, count]) => ({ locator: locator.split(root).join('<root>'), naming: count, tracing: tracing.get(locator) ?? 0 }))

  if (ran.status !== 0) {
    console.log(`${corpus.name}: term make exited ${ran.status}\n${(ran.stdout + ran.stderr).slice(-1500)}`)
  }

  return { corpus: corpus.name, units: units.length, exit: ran.status ?? 1, shape: countOf('shape'), body: countOf('body'), all: countOf(''), most }
}

const share = (count: Count): string => (count.naming === 0 ? 'n/a' : `${((100 * count.tracing) / count.naming).toFixed(1)}%`)
const row = (label: string, count: Count): string =>
  `${label} ${count.tasks} carried, ${count.naming} naming units, ${count.tracing} tracing units, ${share(count)}`

const results: Measured[] = []

for (const corpus of CORPORA) {
  if (only.length > 0 && !only.includes(corpus.name)) continue

  const started = Date.now()
  const measured = measure(corpus)
  results.push(measured)
  console.log(`${measured.corpus}: ${measured.units} units built in ${Math.round((Date.now() - started) / 1000)} s, exit ${measured.exit}`)
  console.log(`  ${row('shapes', measured.shape)}`)
  console.log(`  ${row('bodies', measured.body)}`)
  console.log(`  ${row('all   ', measured.all)}`)

  for (const one of measured.most) console.log(`    ${one.locator}: ${one.naming} naming, ${one.tracing} tracing`)
}

const base = results.find(one => one.corpus === 'base')

// a build that failed has counted only part of its units, and gives no verdict
if (base !== undefined && base.exit !== 0) {
  console.log('verdict: NOT MEASURED, the base build failed')
} else if (base !== undefined) {
  const ratio = base.all.naming === 0 ? 1 : base.all.tracing / base.all.naming
  const verdict =
    ratio < GATE
      ? `BUILD 0526: traced units are ${(100 * ratio).toFixed(1)}% of naming units on base, under ${100 * GATE}%`
      : `REJECT 0526: traced units are ${(100 * ratio).toFixed(1)}% of naming units on base, ${100 * GATE}% or more; decision 077 section 8 drops to a body-only cutoff`

  console.log(`verdict: ${verdict}`)
}

process.exit(results.some(one => one.exit !== 0 || one.units === 0) ? 1 : 0)
