/**
 * The Seed compiler audit: one command that runs the whole automated
 * bug-hunt and prints a consolidated report. It combines every oracle
 * the verification package has into a single gate:
 *
 *   1. CORPUS ORACLES (over real .tree files, default: the stdlib)
 *      - round-trip: canonical printed form is a parse fixpoint
 *      - deterministic: compiling twice gives identical output
 *      - cross-backend: a compiling program emits without throwing
 *      - tolerant: the editor parser never throws on any input
 *      - perf: the slowest files are reported
 *   2. FUZZING (structure-aware mutation of valid programs)
 *      - crashes: any input that makes the compiler throw
 *      - hangs: any input that does not terminate (child-process watchdog)
 *
 * Run from the seed install root:
 *   npx tsx deck/test/code/compiler-audit.ts [--glob <dir>] [--runs N] [--seeds N]
 *
 * Exits non-zero if any finding is reported, so it gates CI. New parser /
 * mill / checker / backend work should re-run this. See the
 * `audit-seed-compiler` skill for the triage workflow.
 */

import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { parseTolerant } from '@cluesurf/make/code/parser/tree'
import { projectResolver } from '@cluesurf/call/code/make'
import { auditCorpus } from './compiler-oracles'
import type { FuzzReport } from './compiler-fuzz'

const HERE = path.dirname(fileURLToPath(import.meta.url))

async function main(): Promise<void> {
  const argv = await yargs(hideBin(process.argv))
    .scriptName('seed-audit')
    .option('glob', { type: 'string', default: 'deck/base/code', describe: 'directory of .tree files to audit' })
    .option('runs', { type: 'number', default: 3000, describe: 'fuzz inputs per seed' })
    .option('seeds', { type: 'number', default: 4, describe: 'distinct fuzz seeds' })
    .option('perf-budget', { type: 'number', default: 1000, describe: 'per-file slow threshold (ms)' })
    .option('fuzz-timeout', { type: 'number', default: 90, describe: 'watchdog seconds per fuzz seed' })
    .strict()
    .help()
    .parse()

  const root = process.cwd()
  const resolve = projectResolver(root, 'node', root)
  let findings = 0

  // ---- phase 1: corpus oracles ----
  console.log(`\n=== corpus oracles: ${argv.glob} ===`)
  let files: string[] = []
  try {
    files = execSync(`find ${argv.glob} -name "*.tree"`, { encoding: 'utf8', cwd: root }).trim().split('\n').filter(Boolean)
  } catch {
    files = []
  }

  if (files.length === 0) {
    console.log('  (no .tree files found)')
  } else {
    const audit = auditCorpus({
      files,
      readFile: f => readFileSync(path.resolve(root, f), 'utf8'),
      resolve,
      parseTolerant,
      perfBudgetMs: argv.perfBudget,
    })
    console.log(`  ${audit.files} files checked`)
    if (audit.violations.length === 0) {
      console.log('  no oracle violations (round-trip, determinism, cross-backend, tolerant all hold)')
    } else {
      findings += audit.violations.length
      console.log(`  ${audit.violations.length} VIOLATION(S):`)
      for (const v of audit.violations.slice(0, 20)) {
        console.log(`    [${v.violation.oracle}] ${v.file}: ${v.violation.detail}`)
      }
    }
    console.log('  slowest files:')
    for (const s of audit.slowest) console.log(`    ${s.ms.toFixed(0)}ms  ${s.file}`)
  }

  // ---- phase 2: fuzzing (crash + hang, hang-safe via child watchdog) ----
  console.log(`\n=== fuzzing: ${argv.seeds} seeds x ${argv.runs} inputs ===`)
  const campaign = path.join(HERE, 'fuzz-campaign.ts')
  const crashSignatures = new Set<string>()
  let hangs = 0
  let totalCrashes = 0

  for (let seed = 1; seed <= argv.seeds; seed++) {
    const work = mkdtempSync(path.join(tmpdir(), 'seed-audit-'))
    const reportOut = path.join(work, 'report.json')
    const probeFile = path.join(work, 'probe.tree')

    const child = spawnSync(
      'npx',
      ['tsx', campaign, reportOut, probeFile, String(argv.runs), String(seed)],
      { timeout: argv.fuzzTimeout * 1000, encoding: 'utf8', cwd: root },
    )
    const hung = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'

    if (hung) {
      hangs++
      findings++
      const input = existsSync(probeFile) ? readFileSync(probeFile, 'utf8') : '(probe missing)'
      console.log(`  seed ${seed}: HANG on input:`)
      console.log(input.split('\n').map(l => '      | ' + l).join('\n'))
    } else if (existsSync(reportOut)) {
      const report = JSON.parse(readFileSync(reportOut, 'utf8')) as FuzzReport
      totalCrashes += report.crashes.length
      for (const c of report.crashes) crashSignatures.add(c.error.split('\n')[0]!.slice(0, 100))
      process.stdout.write(`  seed ${seed}: ${report.crashes.length} crashes, ${report.codesSeen.length} codes exercised\n`)
    } else {
      console.log(`  seed ${seed}: campaign produced no report (status ${child.status})`)
    }
  }

  if (crashSignatures.size > 0) {
    findings += crashSignatures.size
    console.log(`\n  ${totalCrashes} crashes, ${crashSignatures.size} distinct signature(s):`)
    for (const sig of crashSignatures) console.log(`    - ${sig}`)
  } else if (hangs === 0) {
    console.log('  no crashes, no hangs')
  }

  // ---- verdict ----
  console.log(`\n=== audit ${findings === 0 ? 'CLEAN' : `found ${findings} issue(s)`} ===`)
  process.exit(findings === 0 ? 0 : 1)
}

main().catch(e => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(2)
})
