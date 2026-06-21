/**
 * One compiler-fuzzing campaign, as a child-process entry point. The
 * demo spawns this under an overall timeout so a non-terminating input
 * (a compiler hang) kills THIS process instead of the demo; the probe
 * file then holds the offending input. On normal completion it writes a
 * JSON FuzzReport to the path in argv[2].
 *
 * Usage (normally spawned, not run by hand):
 *   tsx fuzz-campaign.ts <report-out> <probe-file> <runs> <seed>
 */

import { writeFileSync } from 'node:fs'
import { fuzzCompiler, DEFAULT_FUZZ_CORPUS } from './compiler-fuzz'

const [reportOut, probeFile, runsArg, seedArg] = process.argv.slice(2)

const report = fuzzCompiler({
  corpus: DEFAULT_FUZZ_CORPUS,
  runs: runsArg ? Number(runsArg) : 3000,
  seed: seedArg ? Number(seedArg) : 7,
  probeFile,
})

if (reportOut) writeFileSync(reportOut, JSON.stringify(report))
