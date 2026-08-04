/**
 * `seed hunt` - the automated bug-hunt CLI verb. Points the verification
 * package's multi-oracle engine at the Seed compiler (or any directory of
 * `.tree` files): metamorphic oracles (parse round-trip is a fixpoint),
 * differential oracles (recompile determinism, cross-backend totality),
 * the editor-robustness oracle (the tolerant parser never throws), a perf
 * budget, and hang-safe structure-aware fuzzing (a child-process watchdog
 * catches non-terminating inputs). Exits non-zero on any finding, so it
 * gates CI.
 *
 * The engine lives in `@cluesurf/test`; this verb owns the project
 * resolver (from `call`) and the process glue, then delegates to
 * `huntSeedCompiler` - the same discipline as `seed hold`.
 */

import { projectResolver } from '@term/call/code/make'
import {
  huntSeedCompiler,
  renderHunt,
} from '@term/test/code/seed-hunt'
import { logGood, logFail } from '@term/make/code/tint'

export async function callHunt(input: {
  root: string
  glob?: string
  runs?: number
  seeds?: number
  fuzzTimeout?: number
  json?: boolean
}): Promise<void> {
  const { root } = input
  const result = huntSeedCompiler({
    root,
    resolve: projectResolver(root, 'node', root),
    glob: input.glob,
    runs: input.runs,
    seeds: input.seeds,
    fuzzTimeoutSec: input.fuzzTimeout,
  })

  if (input.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderHunt(result))

    if (result.findings === 0) {logGood('No issues found')}
    else {logFail(`Found ${result.findings} issue(s)`)}
  }

  process.exit(result.findings === 0 ? 0 : 1)
}
