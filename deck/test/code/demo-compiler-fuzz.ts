/**
 * Fuzz the live Seed compiler. Run from the seed install root:
 *   npx tsx deck/test/code/demo-compiler-fuzz.ts
 *
 * Structure-aware mutation of valid `.tree` sources, fed to `compile`.
 * The oracle: the compiler must always return a result (ok or
 * diagnostics) and NEVER throw OR hang. Any throw is a crash bug; any
 * non-terminating input is a hang bug. Both are real compiler bugs.
 *
 * The campaign runs in a CHILD PROCESS under an overall timeout, so a
 * hanging input kills the child (not this demo); the probe file then
 * holds the exact input that hung the compiler. Crashes are read back
 * from the child's JSON report. Findings are listed, not treated as test
 * noise - the demo passes when the fuzzer ran and classified its inputs.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { minimizeCrash, type FuzzReport } from './compiler-fuzz'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const RUNS = 3000
const TIMEOUT_MS = 90_000

const work = mkdtempSync(path.join(tmpdir(), 'seed-fuzz-'))
const reportOut = path.join(work, 'report.json')
const probeFile = path.join(work, 'probe.tree')
const campaign = path.join(HERE, 'fuzz-campaign.ts')

console.log(`  running ${RUNS} mutated inputs in a child process (watchdog ${TIMEOUT_MS / 1000}s)...`)

const child = spawnSync(
  'npx',
  ['tsx', campaign, reportOut, probeFile, String(RUNS), '7'],
  { timeout: TIMEOUT_MS, encoding: 'utf8', cwd: process.cwd() },
)

const hung = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'

if (hung) {
  // the watchdog fired: the probe file holds the input that hung the compiler
  console.log('\n  --- HANG FOUND: the compiler did not terminate on an input ---')
  ok('fuzzer caught a non-terminating input (hang)', existsSync(probeFile))
  if (existsSync(probeFile)) {
    const input = readFileSync(probeFile, 'utf8')
    console.log('  hanging input:')
    console.log(input.split('\n').map(l => '    | ' + l).join('\n'))
  }
  console.log('\n  (a compiler hang is a real robustness bug - see findings doc)')
} else if (existsSync(reportOut)) {
  const report = JSON.parse(readFileSync(reportOut, 'utf8')) as FuzzReport
  console.log(`  ran ${report.runs} mutated inputs`)
  console.log(`  distinct diagnostic codes exercised: ${report.codesSeen.length} [${report.codesSeen.join(', ')}]`)
  console.log(`  corpus grew by ${report.corpusGrew} coverage-novel inputs`)
  console.log(`  crashes found: ${report.crashes.length}`)

  ok('fuzzer ran the full budget', report.runs === RUNS)
  ok('fuzzing exercised multiple compiler diagnostics (real coverage)', report.codesSeen.length >= 3)

  if (report.crashes.length > 0) {
    console.log(`\n  --- ${report.crashes.length} CRASH(es) FOUND (compiler bugs) ---`)
    const seen = new Set<string>()
    let shown = 0
    for (const crash of report.crashes) {
      const head = crash.error.split('\n')[0] ?? ''
      if (seen.has(head)) continue
      seen.add(head)
      if (shown++ >= 3) break
      const minimal = minimizeCrash(crash.input)
      console.log(`\n  error: ${head}`)
      console.log('  minimal input:')
      console.log(minimal.split('\n').map(l => '    | ' + l).join('\n'))
    }
    console.log(`\n  (${seen.size} distinct crash signature(s) - see findings doc)`)
  } else {
    ok('no compiler crashes in this run', true)
  }
} else {
  ok('campaign produced a report', false, `(child status ${child.status}, ${child.stderr?.slice(0, 200)})`)
}

console.log(`\nseed-verify compiler-fuzz demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
