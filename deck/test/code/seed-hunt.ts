/**
 * The Term-compiler instantiation of the generic `hunt` engine: wire the
 * compiler's oracles (round-trip, determinism, backend-emit, tolerant,
 * crash) and the `.tree` mutator into one orchestrated bug-hunt, with
 * hang-safe fuzzing (a child-process watchdog catches non-terminating
 * inputs). Both the standalone audit script (`compiler-audit.ts`) and the
 * `term hunt` CLI verb call `huntSeedCompiler` so there is one engine.
 *
 * The resolver is injected (it lives in `@term/call`), keeping this
 * package free of a call<->test cycle - same discipline as `prove-file`.
 *
 * FAIL CLOSED. A hunt is `ok` only when every check RAN on at least one
 * input and found nothing. Zero files read, a fuzz child that exited
 * non-zero or wrote no report, or zero fuzz runs executed is recorded in
 * `unrun` and fails the hunt, because a check that did not run reads
 * exactly like a check that passed. Both shapes shipped: the default
 * corpus path pointed at a directory that no longer existed, and the
 * built CLI spawned a fuzz campaign at a path that only exists in source.
 */

import { readFileSync, existsSync, mkdtempSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTolerant } from '@term/make/code/parser/tree'
import type { Resolver } from '@term/make/code/compile/load'
import { auditCorpus, EMIT_BACKENDS, type CorpusAudit } from './compiler-oracles'
import { signatureOf, type FuzzReport } from './compiler-fuzz'

/** How to start one fuzz campaign as a child: the campaign's own args are appended. */
export type FuzzEntry = { command: string; args: string[] }

export type HuntResult = {
  corpus: CorpusAudit
  // the backends the backend-emit oracle drove (emit only, nothing built or run)
  backends: string[]
  fuzz: {
    // seeds whose campaign finished and wrote a report
    seedsRun: number
    seedsAsked: number
    // mutated inputs actually compiled, summed over the reports
    runs: number
    // extra seed programs taken from the hunted files
    corpusAdded: number
  }
  // one per distinct signature, with the smallest program that raises it, so a crash can be reproduced without
  // fuzzing again: SHRUNK by delta debugging in the campaign (compiler-fuzz.ts `shrinkCrash`), and `from` the
  // mutated program the fuzzer hit, when the shrink got smaller
  crashes: { total: number; found: { signature: string; input: string; from?: string }[] }
  hangs: { input: string }[]
  // fuzzed inputs whose compile took longer than the budget, the slowest first
  slow: { input: string; ms: number }[]
  // what did not run, in plain words. Non-empty fails the hunt.
  unrun: string[]
  findings: number
  ok: boolean
}

// every `.tree` beneath a directory, or nothing when the directory is absent
function treeFilesUnder(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) {
    return out
  }

  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'host' || entry.startsWith('.')) {
      continue
    }

    const full = path.join(dir, entry)

    if (statSync(full).isDirectory()) {
      treeFilesUnder(full, out)
    } else if (entry.endsWith('.tree')) {
      out.push(full)
    }
  }

  return out
}

// From SOURCE, the campaign is the sibling fuzz-campaign.ts under tsx. Undefined when that file is not beside this
// module, which is the case inside any bundle: a caller there must pass `fuzzEntry` (the CLI forks itself).
function sourceFuzzEntry(): FuzzEntry | undefined {
  let here: string
  try {
    here = path.dirname(fileURLToPath(import.meta.url))
  } catch {
    return undefined
  }
  const campaign = path.join(here, 'fuzz-campaign.ts')
  // the child runs with the hunted project as its cwd, where tsx would find no tsconfig and so no `@term/*` paths
  const tsconfig = path.resolve(here, '../../../tsconfig.json')
  return existsSync(campaign)
    ? { command: 'npx', args: ['tsx', '--tsconfig', tsconfig, campaign] }
    : undefined
}

// the hunted files that make good fuzz seeds: small enough that a mutation is still near a real program
function fuzzSeedsFrom(files: string[], read: (file: string) => string): string[] {
  const out: string[] = []
  for (const f of files) {
    if (out.length >= 32) break
    try {
      const text = read(f)
      if (text.length > 0 && text.length <= 4000) out.push(text)
    } catch {
      // unreadable files are reported by the corpus phase
    }
  }
  return out
}

/** Run the full compiler bug-hunt: corpus oracles + watchdog fuzz. */
export function huntSeedCompiler(input: {
  root: string
  resolve: Resolver
  // the files to hunt, relative to root or absolute. When given, `glob` is ignored.
  files?: string[]
  // a directory under root to walk for `.tree` files, when `files` is not given. There is no default directory:
  // the CLI passes the project's own files, the way `term make` finds them.
  glob?: string
  runs?: number
  seeds?: number
  perfBudgetMs?: number
  fuzzTimeoutSec?: number
  fuzzEntry?: FuzzEntry
  // the text the build compiles for a file (an absolute path), when that is not the file as written: a test file with
  // its `test` blocks rewritten. The caller owns that rule; read as written, a test file never compiled here
  read?: (file: string) => string
}): HuntResult {
  const { root, resolve } = input
  const readText = (f: string): string => {
    const full = path.resolve(root, f)

    return input.read ? input.read(full) : readFileSync(full, 'utf8')
  }
  const runs = input.runs ?? 3000
  const seeds = input.seeds ?? 4
  const fuzzTimeoutSec = input.fuzzTimeoutSec ?? 90
  // one compile's budget, held on the corpus and on every fuzzed input
  const perfBudgetMs = input.perfBudgetMs ?? 1000
  const unrun: string[] = []

  // ---- phase 1: corpus oracles ----
  const files = (
    input.files ?? (input.glob ? treeFilesUnder(path.resolve(root, input.glob)) : [])
  ).map(f => (path.isAbsolute(f) ? path.relative(root, f) : f))

  const corpus = auditCorpus({
    files,
    readFile: readText,
    resolve,
    parseTolerant,
    perfBudgetMs,
  })

  if (corpus.files === 0) {
    unrun.push(
      input.files === undefined && input.glob
        ? `corpus oracles: no .tree files read under ${input.glob}`
        : 'corpus oracles: no .tree files read',
    )
  }
  if (corpus.unreadable.length > 0) {
    unrun.push(`corpus oracles: ${corpus.unreadable.length} file(s) could not be read (${corpus.unreadable.slice(0, 3).join(', ')})`)
  }
  if (corpus.files > 0 && corpus.compiled === 0) {
    unrun.push(`backend emit: none of the ${corpus.files} file(s) compiled, so no backend emitted anything`)
  }

  // ---- phase 2: hang-safe fuzzing (child-process watchdog) ----
  const entry = input.fuzzEntry ?? sourceFuzzEntry()
  // per signature, the smallest program that raises it, and the mutated program it was shrunk from
  const found = new Map<string, { input: string; from?: string }>()
  const hangs: { input: string }[] = []
  const slow: { input: string; ms: number }[] = []
  let totalCrashes = 0
  let seedsRun = 0
  let fuzzRuns = 0
  const extraSeeds = fuzzSeedsFrom(files, readText)

  if (!entry) {
    unrun.push('fuzzing: no fuzz campaign entry (fuzz-campaign.ts is not beside this module and none was passed)')
  } else if (seeds < 1 || runs < 1) {
    unrun.push(`fuzzing: asked for ${seeds} seed(s) of ${runs} run(s), so nothing was fuzzed`)
  } else {
    const work = mkdtempSync(path.join(tmpdir(), 'term-hunt-'))
    const corpusFile = path.join(work, 'corpus.json')
    writeFileSync(corpusFile, JSON.stringify(extraSeeds))

    for (let seed = 1; seed <= seeds; seed++) {
      const reportOut = path.join(work, `report-${seed}.json`)
      const probeFile = path.join(work, `probe-${seed}.tree`)

      const child = spawnSync(
        entry.command,
        [...entry.args, reportOut, probeFile, String(runs), String(seed), corpusFile, String(perfBudgetMs)],
        { timeout: fuzzTimeoutSec * 1000, encoding: 'utf8', cwd: root },
      )
      const hung = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'

      if (hung) {
        // a hang is a finding only with the input that hung. With no probe the watchdog fired before the campaign
        // wrote its first input (startup, or a timeout too short to load the compiler), which is a run that did not
        // happen, not a compiler that looped.
        if (existsSync(probeFile)) {
          hangs.push({ input: readFileSync(probeFile, 'utf8') })
        } else {
          unrun.push(
            `fuzz seed ${seed}: the ${fuzzTimeoutSec}s watchdog fired before the campaign wrote its first input`,
          )
        }

        // a campaign that finished fuzzing and hung while it SHRANK has written what it found first: keep it, unshrunk
        const written = existsSync(reportOut) ? readReport(reportOut) : undefined

        if (written) {
          seedsRun++
          fuzzRuns += written.runs
          collect(written)
        }

        continue
      }

      if (child.error !== undefined) {
        unrun.push(`fuzz seed ${seed}: could not start ${entry.command}: ${child.error.message}`)
        continue
      }

      if (child.status !== 0) {
        const why = child.status === null ? `was killed by ${child.signal}` : `exited ${child.status}`
        // the error line, not the last line: node ends a crash with its own version banner
        const lines = (child.stderr ?? '').split('\n').map(l => l.trim()).filter(l => l.length > 0)
        const tail = (lines.find(l => /error/i.test(l)) ?? lines.slice(-1)[0] ?? '').slice(0, 300)
        unrun.push(`fuzz seed ${seed}: the campaign ${why}${tail ? `: ${tail}` : ''}`)
        continue
      }

      if (!existsSync(reportOut)) {
        unrun.push(`fuzz seed ${seed}: the campaign exited 0 but wrote no report`)
        continue
      }

      let report: FuzzReport
      try {
        report = JSON.parse(readFileSync(reportOut, 'utf8')) as FuzzReport
      } catch (e) {
        unrun.push(`fuzz seed ${seed}: unreadable report: ${e instanceof Error ? e.message : String(e)}`)
        continue
      }

      seedsRun++
      fuzzRuns += report.runs
      collect(report)
    }

    if (seedsRun > 0 && fuzzRuns === 0) {
      unrun.push('fuzzing: the campaigns finished but executed zero runs')
    }
  }

  const findings = corpus.violations.length + found.size + hangs.length + slow.length
  return {
    corpus,
    backends: EMIT_BACKENDS.map(b => b.name),
    fuzz: { seedsRun, seedsAsked: seeds, runs: fuzzRuns, corpusAdded: extraSeeds.length },
    crashes: { total: totalCrashes, found: [...found].map(([signature, one]) => ({ signature, ...one })) },
    hangs,
    slow: slow.sort((a, b) => b.ms - a.ms),
    unrun,
    findings,
    ok: findings === 0 && unrun.length === 0,
  }

  // one campaign's report into the totals: its crashes by signature, the shrunk program where it has one and the
  // smallest it hit where it does not, and its slow inputs
  function collect(report: FuzzReport): void {
    totalCrashes += report.crashes.length

    for (const c of report.crashes) {
      const signature = signatureOf(c.error)
      const known = found.get(signature)

      if (known === undefined || c.input.length < known.input.length) {
        found.set(signature, { input: c.input })
      }
    }

    for (const one of report.shrunk ?? []) {
      const known = found.get(one.signature)

      if (known === undefined || one.input.length < known.input.length) {
        found.set(one.signature, one.input === one.from ? { input: one.input } : { input: one.input, from: one.from })
      }
    }

    slow.push(...(report.slow ?? []))
  }
}

// a campaign's report, or nothing when it is not one
function readReport(file: string): FuzzReport | undefined {
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as FuzzReport
  } catch {
    return undefined
  }
}

/** Render a hunt result as a terminal report. */
export function renderHunt(result: HuntResult): string {
  const out: string[] = []
  const c = result.corpus
  out.push(`=== corpus oracles: ${c.files} file(s) read, ${c.compiled} compiled ===`)

  // An EMPTY corpus is not a clean one, and saying so is the whole point. This reported `no oracle violations`
  // over zero files for as long as the default glob pointed at the pre-rename `deck/base/code`: the oracles held
  // vacuously, and the line read exactly like a real pass.
  if (c.files === 0) {
    out.push('  NO FILES READ, so no oracle ran.')
  } else if (c.violations.length === 0) {
    out.push(`  no oracle violations (round-trip, determinism, tolerant parse; backend emit on ${c.compiled} compiled file(s))`)
  } else {
    out.push(`  ${c.violations.length} VIOLATION(S):`)
    for (const v of c.violations.slice(0, 20)) {
      out.push(`    [${v.violation.oracle}] ${v.file}: ${v.violation.detail}`)
    }
  }
  out.push(`  backend emit: ${result.backends.join(', ')}. Emit only: nothing is built, run or compared across backends.`)
  if (c.slowest.length > 0) {
    out.push('  slowest files:')
    for (const s of c.slowest) out.push(`    ${s.ms.toFixed(0)}ms  ${s.file}`)
  }

  out.push('')
  const f = result.fuzz
  out.push(
    `=== fuzzing: ${f.runs} run(s) over ${f.seedsRun} of ${f.seedsAsked} seed(s), corpus ${f.corpusAdded} project file(s) + defaults ===`,
  )
  if (result.hangs.length > 0) {
    out.push(`  ${result.hangs.length} HANG(S):`)
    for (const h of result.hangs) out.push(h.input.split('\n').map(l => '      | ' + l).join('\n'))
  }
  if (result.crashes.found.length > 0) {
    out.push(`  ${result.crashes.total} crashes, ${result.crashes.found.length} distinct signature(s):`)
    for (const crash of result.crashes.found) {
      out.push(`    - ${crash.signature}${crash.from !== undefined ? `  (shrunk from ${crash.from.split('\n').length} lines to ${crash.input.split('\n').length})` : ''}`)
      out.push(crash.input.split('\n').map(l => '      | ' + l).join('\n'))
    }
  }
  if (result.slow.length > 0) {
    out.push(`  ${result.slow.length} SLOW INPUT(S), over the compile budget:`)
    for (const one of result.slow.slice(0, 5)) {
      out.push(`    - ${one.ms}ms`)
      out.push(one.input.split('\n').map(l => '      | ' + l).join('\n'))
    }
  }
  if (result.hangs.length === 0 && result.crashes.found.length === 0 && result.slow.length === 0) {
    out.push(f.runs > 0 ? '  no crashes, no hangs, none over the compile budget' : '  NOTHING FUZZED')
  }

  if (result.unrun.length > 0) {
    out.push('')
    out.push('=== did not run ===')
    for (const u of result.unrun) out.push(`  - ${u}`)
  }

  out.push('')
  const emitted = c.compiled > 0 ? result.backends.length : 0
  const counts = `${c.files} file(s) read, ${f.runs} fuzz run(s), ${emitted} backend(s) emitted`
  if (result.ok) {
    out.push(`=== hunt CLEAN: ${counts} ===`)
  } else if (result.findings > 0) {
    out.push(`=== hunt FOUND ${result.findings} issue(s): ${counts} ===`)
  } else {
    out.push(`=== hunt INCOMPLETE, ${result.unrun.length} check(s) did not run: ${counts} ===`)
  }
  return out.join('\n')
}
