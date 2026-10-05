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

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { buildable, findTreeFiles, projectResolver } from '@term/call/code/make'
import { projectRoleOf } from '@term/call/code/role-of'
import {
  huntSeedCompiler,
  type FuzzEntry,
  type HuntResult,
} from '@term/test/code/seed-hunt'
import { runFuzzCampaign } from '@term/test/code/compiler-fuzz'
import { closeRun, count, field, openRun, printData, report } from '@term/call/code/output'

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
    process.stderr.write(`${e instanceof Error ? e.stack ?? e.message : String(e)}\n`) // output: protocol, the child's stack for its watchdog
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
  // the run's real start: its opening item is printed after the hunt (below), and its clock and total are this one
  const started = Date.now()

  // the project's own code, found the way `term make` finds it (manifests, role files, lockfiles and drafts are
  // skipped, other platforms' native trees too). This defaulted to `deck/base/code`, the compiler's stdlib, which a
  // user project does not have: the run read nothing and still said CLEAN.
  const dir = input.glob ? path.resolve(root, input.glob) : root
  const files = existsSync(dir) ? findTreeFiles(dir, [], 'node') : []
  const roleOf = projectRoleOf(root)

  const result = huntSeedCompiler({
    root,
    resolve: projectResolver(root, 'node', root),
    files,
    runs: input.runs,
    seeds: input.seeds,
    fuzzTimeoutSec: input.fuzzTimeout,
    fuzzEntry: selfFuzzEntry(),
    // each file as the build reads it, so a test file is rewritten first, as `term test` rewrites it
    read: file => {
      const source = readFileSync(file, 'utf8')
      const made = buildable(file, source, roleOf(file))

      return 'text' in made ? made.text : source
    },
  })

  if (input.glob && !existsSync(dir)) {
    result.unrun.unshift(`corpus: ${input.glob} does not exist under ${root}`)
    result.ok = false
  }

  if (input.json) {
    printData(`${JSON.stringify(result, null, 2)}\n`)
    process.exit(result.ok ? 0 : 1)
  }

  // the run is opened after the hunt: the fuzz children inherit this process's stderr while they run, and a live
  // opening item would sit above their noise. The verdict and exit follow `result.ok`, which is false whenever a
  // check did not run, so the closing item is ✗ for an incomplete hunt as well as for a finding
  openRun({ verb: 'hunt', root, counts: [count(files.length, 'files', 'file')], started })
  reportHunt(result)
  const counts = [count(result.corpus.files, 'files read', 'file read'), count(result.fuzz.runs, 'fuzz runs', 'fuzz run')]
  process.exit(
    closeRun({
      verdict: result.ok ? 'No issues found, every check ran' : result.findings > 0 ? `Found ${result.findings} issue${result.findings === 1 ? '' : 's'}` : 'Not a pass: some checks did not run',
      counts,
    }),
  )
}

// the hunt as items: one per oracle family with its counts, a ✗ per violation, crash signature and hang, and a ✗
// per check that did not run. What renderHunt (in @term/test) prints as banners, in the standard's shape
function reportHunt(result: HuntResult): void {
  const c = result.corpus

  report({
    glyph: c.files === 0 ? 'failed' : c.violations.length > 0 ? 'failed' : 'done',
    verb: 'check',
    subject: c.files === 0 ? 'No files read, so no oracle ran' : 'Corpus oracles: round trip, determinism, tolerant parse, backend emit',
    counts: [count(c.files, 'files', 'file'), count(c.compiled, 'compiled'), count(c.violations.length, 'violations', 'violation')],
    facts: [`emit ${result.backends.join(', ')}`],
  })

  for (const v of c.violations.slice(0, 20)) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: v.violation.detail, facts: [v.violation.oracle], fields: [field('in', v.file)] })
  }

  for (const s of c.slowest) {
    report({ glyph: 'info', verb: 'check', subject: s.file, duration: Math.round(s.ms), facts: ['slowest'], level: 'debug' })
  }

  const f = result.fuzz
  report({
    glyph: f.runs === 0 || result.hangs.length > 0 || result.crashes.found.length > 0 ? 'failed' : 'done',
    verb: 'fuzz',
    subject: f.runs === 0 ? 'Nothing was fuzzed' : 'Structure-aware fuzzing under a watchdog',
    counts: [
      count(f.runs, 'runs', 'run'),
      count(f.seedsRun, 'seeds', 'seed', f.seedsAsked),
      count(result.crashes.total, 'crashes', 'crash'),
      count(result.hangs.length, 'hangs', 'hang'),
      count(f.corpusAdded, 'project files added', 'project file added'),
    ],
  })

  // the signature, then the smallest program that raised it, so the crash can be reproduced from the report
  for (const crash of result.crashes.found) {
    report({ glyph: 'failed', kind: 'problem', verb: 'fuzz', subject: 'The compiler crashed', quote: [crash.signature, '', ...crash.input.split('\n')] })
  }

  for (const hang of result.hangs) {
    report({ glyph: 'failed', kind: 'problem', verb: 'fuzz', subject: 'The compiler did not finish on this input', quote: hang.input.split('\n') })
  }

  for (const missing of result.unrun) {
    report({ glyph: 'failed', kind: 'problem', verb: 'check', subject: missing.charAt(0).toUpperCase() + missing.slice(1), facts: ['did not run'] })
  }
}
