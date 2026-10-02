/**
 * `term hunt` - the automated bug-hunt CLI verb. Points the verification
 * package's multi-oracle engine at the current project's `.tree` files (or
 * a directory given on the command line): metamorphic oracles (parse
 * round-trip is a fixpoint), recompile determinism, backend emit (all four
 * emitters accept a compiling program), the editor-robustness oracle (the
 * tolerant parser never throws), a perf budget, and hang-safe
 * structure-aware fuzzing (a child-process watchdog catches
 * non-terminating inputs). Exits non-zero on any finding AND whenever a
 * check did not run, so it gates CI.
 *
 * The engine lives in `@term/test`; this verb owns the project resolver,
 * the file walk and the process glue, then delegates to `huntSeedCompiler`
 * - the same discipline as `term hold`.
 */

import { existsSync } from 'node:fs'
import path from 'node:path'
import { findTreeFiles, projectResolver } from '@term/call/code/make'
import {
  huntSeedCompiler,
  renderHunt,
  type FuzzEntry,
} from '@term/test/code/seed-hunt'
import { runFuzzCampaign } from '@term/test/code/compiler-fuzz'
import { logGood, logFail } from '@term/make/code/tint'

/**
 * The hidden first argument that makes the CLI run ONE fuzz campaign and exit. `term hunt` forks itself with it
 * for every fuzz seed, so the campaign is the code inside this same bundle: there is no second file to find at run
 * time. It used to spawn `npx tsx <dir>/fuzz-campaign.ts` beside the running module, which inside host/line.js is
 * host/, where no such file exists; the child failed, no report came back, and the run said `no crashes, no hangs`.
 */
export const HUNT_FUZZ_CHILD = '__hunt-fuzz-campaign'

/** The child body: run the campaign named by `args` and exit. */
export function runHuntFuzzChild(args: string[]): never {
  try {
    runFuzzCampaign(args)
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`)
    process.exit(2)
  }
  process.exit(0)
}

// how to start this same CLI as a fuzz child: the same node, the same loader flags (tsx when run from source), the
// same entry script
function selfFuzzEntry(): FuzzEntry | undefined {
  const script = process.argv[1]
  if (!script) return undefined
  return {
    command: process.execPath,
    args: [...process.execArgv, script, HUNT_FUZZ_CHILD],
  }
}

export async function callHunt(input: {
  root: string
  glob?: string
  runs?: number
  seeds?: number
  fuzzTimeout?: number
  json?: boolean
}): Promise<void> {
  const { root } = input

  // the project's own code, found the way `term make` finds it (manifests, role files, lockfiles and drafts are
  // skipped, other platforms' native trees too). This defaulted to `deck/base/code`, the compiler's stdlib, which a
  // user project does not have: the run read nothing and still said CLEAN.
  const dir = input.glob ? path.resolve(root, input.glob) : root
  const files = existsSync(dir) ? findTreeFiles(dir, [], 'node') : []

  const result = huntSeedCompiler({
    root,
    resolve: projectResolver(root, 'node', root),
    files,
    runs: input.runs,
    seeds: input.seeds,
    fuzzTimeoutSec: input.fuzzTimeout,
    fuzzEntry: selfFuzzEntry(),
  })

  if (input.glob && !existsSync(dir)) {
    result.unrun.unshift(`corpus: ${input.glob} does not exist under ${root}`)
    result.ok = false
  }

  if (input.json) {
    console.log(JSON.stringify(result, null, 2))
  } else {
    console.log(renderHunt(result))

    if (result.ok) {
      logGood('No issues found, every check ran')
    } else if (result.findings > 0) {
      logFail(`Found ${result.findings} issue(s)`)
    } else {
      logFail(`${result.unrun.length} check(s) did not run, so this is not a pass`)
    }
  }

  process.exit(result.ok ? 0 : 1)
}
