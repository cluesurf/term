// Nothing in the CLI prints except through the terminal output library (note/term/output/readme.md). A command builds
// events and hands them to code/output.ts; it never calls `console.*`, writes to `process.stdout` / `process.stderr`,
// or imports the old `@term/make/code/tint` helpers.
//
// A RATCHET while the commands are converted (note/term/plan/terminal-output-standard.md, phase 2): every file's
// count of direct-print sites is held to test/call/output-only.json. A count may fall and never rise, a file that is
// not in the baseline must have none, and a file that reached zero stays there. `--commit` rewrites the baseline to
// today's counts, and refuses to raise any. When the baseline is empty the ratchet is the rule.
//
// Run: npx tsx test/call/output-only.ts [--commit]

import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import path from 'node:path'

const CODE = path.join(process.cwd(), 'deck/call/code')
const BASELINE = path.join(process.cwd(), 'test/call/output-only.json')

// the shapes that print without the library. A comment that names one is not a call: only code lines count
const PRINTS = [
  /\bconsole\.(log|error|warn|info|debug)\(/,
  /\bprocess\.(stdout|stderr)\.write\(/,
  /from '@term\/make\/code\/tint'/,
  /\b(logGood|logWarn|logFail|logStep|logHead|showBanner|showInfo)\(/,
]

// the library itself, and the one module that owns the process, are where printing is meant to happen. And
// hook-dispatch.ts is not a `term` command: it is the runtime of a USER's compiled command line, bundled into
// host/dock.mjs and promised browser-safe, and its help and usage lines are that program's own protocol
const OWNERS = new Set(['work', 'output.ts', 'hook-dispatch.ts'])

// a line written to another PROCESS rather than to a person (a fuzz child reporting to its watchdog) is a protocol,
// not a human view, and a print that is TEXT of a generated program (`run.mjs`) is not a print here at all. Each says
// so with a marker on the line itself
const PROTOCOL = /\/\/ output: (protocol|generated)\b/

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)

    if (OWNERS.has(name) && dir === CODE) {
      return []
    }

    return statSync(full).isDirectory() ? files(full) : name.endsWith('.ts') ? [full] : []
  })
}

function sites(file: string): number {
  return readFileSync(file, 'utf8')
    .split('\n')
    .filter(line => !line.trim().startsWith('//') && !PROTOCOL.test(line) && PRINTS.some(shape => shape.test(line))).length
}

const counts: Record<string, number> = {}
const scanned = files(CODE).sort()

for (const file of scanned) {
  const found = sites(file)

  if (found > 0) {
    counts[path.relative(CODE, file)] = found
  }
}

let baseline: Record<string, number> = {}

try {
  baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Record<string, number>
} catch {
  baseline = {}
}

const risen = Object.entries(counts).filter(([file, found]) => found > (baseline[file] ?? 0))
const total = Object.values(counts).reduce((sum, one) => sum + one, 0)
const was = Object.values(baseline).reduce((sum, one) => sum + one, 0)

if (process.argv.includes('--commit')) {
  // the first commit SEEDS the baseline with today's counts (an absent or empty baseline); every later one may only
  // lower them
  const seeding = !existsSync(BASELINE) || Object.keys(baseline).length === 0
  // every file at the lower of its held count and today's: what fell is held there, and what rose is NOT raised
  const held: Record<string, number> = {}

  for (const [file, found] of Object.entries(counts)) {
    const kept = seeding ? found : Math.min(found, baseline[file] ?? 0)

    if (kept > 0) {
      held[file] = kept
    }
  }

  writeFileSync(BASELINE, `${JSON.stringify(held, null, 2)}\n`)
  const now = Object.values(held).reduce((sum, one) => sum + one, 0)
  console.log(`wrote ${path.relative(process.cwd(), BASELINE)}: ${now} sites held in ${Object.keys(held).length} files (was ${was})`)

  if (!seeding && risen.length > 0) {
    console.log(`not raised, and still failing: ${risen.map(([file, found]) => `${file} ${baseline[file] ?? 0} -> ${found}`).join(', ')}`)
    process.exit(1)
  }

  process.exit(0)
}

let pass = 0
let fail = 0

for (const [file, found] of risen) {
  fail++
  console.log(`FAIL  ${file} prints directly at ${found} sites, held to ${baseline[file] ?? 0}: report through code/output.ts`)
}

// every file scanned and held at or under its count is a pass, so a clean CLI reads as the files it checked
pass += scanned.length - risen.length
const fallen = Object.entries(baseline).filter(([file, held]) => (counts[file] ?? 0) < held)

for (const [file, held] of fallen) {
  console.log(`ok    ${file} fell from ${held} to ${counts[file] ?? 0}: run with --commit to hold it there`)
}

console.log(`\ncall/output-only: ${pass} pass, ${fail} fail (${total} direct-print sites left in ${Object.keys(counts).length} files)`)

if (fail > 0) {
  process.exit(1)
}
