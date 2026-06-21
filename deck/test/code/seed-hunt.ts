/**
 * The Seed-compiler instantiation of the generic `hunt` engine: wire the
 * compiler's oracles (round-trip, determinism, cross-backend, tolerant,
 * crash) and the `.tree` mutator into one orchestrated bug-hunt, with
 * hang-safe fuzzing (a child-process watchdog catches non-terminating
 * inputs). Both the standalone audit script (`compiler-audit.ts`) and the
 * `seed hunt` CLI verb call `huntSeedCompiler` so there is one engine.
 *
 * The resolver is injected (it lives in `@cluesurf/call`), keeping this
 * package free of a call<->test cycle - same discipline as `prove-file`.
 */

import { readFileSync, existsSync, mkdtempSync } from 'node:fs'
import { execSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseTolerant } from '@cluesurf/make/code/parser/tree'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import { auditCorpus, type CorpusAudit } from './compiler-oracles'
import type { FuzzReport } from './compiler-fuzz'

const HERE = path.dirname(fileURLToPath(import.meta.url))

export type HuntResult = {
  corpus: CorpusAudit
  crashes: { total: number; signatures: string[] }
  hangs: { input: string }[]
  findings: number
}

/** Run the full Seed-compiler bug-hunt: corpus oracles + watchdog fuzz. */
export function huntSeedCompiler(input: {
  root: string
  resolve: Resolver
  glob?: string
  runs?: number
  seeds?: number
  perfBudgetMs?: number
  fuzzTimeoutSec?: number
}): HuntResult {
  const { root, resolve } = input
  const glob = input.glob ?? 'deck/base/code'
  const runs = input.runs ?? 3000
  const seeds = input.seeds ?? 4
  const fuzzTimeoutSec = input.fuzzTimeoutSec ?? 90

  // ---- phase 1: corpus oracles ----
  let files: string[] = []
  try {
    files = execSync(`find ${glob} -name "*.tree"`, { encoding: 'utf8', cwd: root })
      .trim().split('\n').filter(Boolean)
  } catch {
    files = []
  }

  const corpus = auditCorpus({
    files,
    readFile: f => readFileSync(path.resolve(root, f), 'utf8'),
    resolve,
    parseTolerant,
    perfBudgetMs: input.perfBudgetMs ?? 1000,
  })

  // ---- phase 2: hang-safe fuzzing (child-process watchdog) ----
  const campaign = path.join(HERE, 'fuzz-campaign.ts')
  const signatures = new Set<string>()
  const hangs: { input: string }[] = []
  let totalCrashes = 0

  for (let seed = 1; seed <= seeds; seed++) {
    const work = mkdtempSync(path.join(tmpdir(), 'seed-hunt-'))
    const reportOut = path.join(work, 'report.json')
    const probeFile = path.join(work, 'probe.tree')

    const child = spawnSync(
      'npx',
      ['tsx', campaign, reportOut, probeFile, String(runs), String(seed)],
      { timeout: fuzzTimeoutSec * 1000, encoding: 'utf8', cwd: root },
    )
    const hung = child.error !== undefined && (child.error as NodeJS.ErrnoException).code === 'ETIMEDOUT'

    if (hung) {
      hangs.push({ input: existsSync(probeFile) ? readFileSync(probeFile, 'utf8') : '(probe missing)' })
    } else if (existsSync(reportOut)) {
      const report = JSON.parse(readFileSync(reportOut, 'utf8')) as FuzzReport
      totalCrashes += report.crashes.length
      for (const c of report.crashes) signatures.add(c.error.split('\n')[0]!.slice(0, 100))
    }
  }

  const findings = corpus.violations.length + signatures.size + hangs.length
  return {
    corpus,
    crashes: { total: totalCrashes, signatures: [...signatures] },
    hangs,
    findings,
  }
}

/** Render a hunt result as a terminal report. */
export function renderHunt(result: HuntResult): string {
  const out: string[] = []
  out.push(`=== corpus oracles: ${result.corpus.files} files ===`)
  if (result.corpus.violations.length === 0) {
    out.push('  no oracle violations (round-trip, determinism, cross-backend, tolerant all hold)')
  } else {
    out.push(`  ${result.corpus.violations.length} VIOLATION(S):`)
    for (const v of result.corpus.violations.slice(0, 20)) {
      out.push(`    [${v.violation.oracle}] ${v.file}: ${v.violation.detail}`)
    }
  }
  out.push('  slowest files:')
  for (const s of result.corpus.slowest) out.push(`    ${s.ms.toFixed(0)}ms  ${s.file}`)

  out.push('')
  out.push('=== fuzzing ===')
  if (result.hangs.length > 0) {
    out.push(`  ${result.hangs.length} HANG(S):`)
    for (const h of result.hangs) out.push(h.input.split('\n').map(l => '      | ' + l).join('\n'))
  }
  if (result.crashes.signatures.length > 0) {
    out.push(`  ${result.crashes.total} crashes, ${result.crashes.signatures.length} distinct signature(s):`)
    for (const sig of result.crashes.signatures) out.push(`    - ${sig}`)
  }
  if (result.hangs.length === 0 && result.crashes.signatures.length === 0) {
    out.push('  no crashes, no hangs')
  }

  out.push('')
  out.push(`=== hunt ${result.findings === 0 ? 'CLEAN' : `found ${result.findings} issue(s)`} ===`)
  return out.join('\n')
}
