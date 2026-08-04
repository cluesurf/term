/**
 * The Seed compiler audit, as a standalone runner. Thin wrapper over the
 * shared `huntSeedCompiler` engine (seed-hunt.ts), which both this script
 * and the `seed hunt` CLI verb call. Runs the corpus oracles
 * (round-trip, determinism, cross-backend, tolerant, perf) plus hang-safe
 * fuzzing, and exits non-zero on any finding so it gates CI.
 *
 * Run from the seed install root:
 *   npx tsx deck/test/code/compiler-audit.ts [--glob <dir>] [--runs N] [--seeds N]
 *
 * See the `hunt-bugs` skill for the triage workflow.
 */

import yargs from 'yargs'
import { hideBin } from 'yargs/helpers'
import { projectResolver } from '@term/call/code/make'
import { huntSeedCompiler, renderHunt } from './seed-hunt'

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
  const result = huntSeedCompiler({
    root,
    resolve: projectResolver(root, 'node', root),
    glob: argv.glob,
    runs: argv.runs,
    seeds: argv.seeds,
    perfBudgetMs: argv.perfBudget,
    fuzzTimeoutSec: argv.fuzzTimeout,
  })

  console.log(renderHunt(result))
  process.exit(result.findings === 0 ? 0 : 1)
}

main().catch(e => {
  process.stderr.write(`${e instanceof Error ? e.stack : String(e)}\n`)
  process.exit(2)
})
