/**
 * Incremental `seed hold`: verify many files, skipping the ones whose
 * content (and dependency content, and toolchain version) is unchanged
 * since they last held. This is what makes verification usable across a
 * whole project - the first run checks everything, later runs only
 * re-check what moved.
 *
 * The key per file folds in the file's own source AND the source of
 * every module it loads (via `collectModules`), so a change to a
 * dependency correctly invalidates a dependent's cached verdict. The
 * expensive work skipped on a hit is the type check plus the four
 * backend emits in the cross-differential.
 */

import { readFileSync } from 'node:fs'
import { collectModules } from '@cluesurf/make/code/compile/load'
import type { Resolver } from '@cluesurf/make/code/compile/load'
import { proveFile, type Report } from './prove-file'
import { obligationKey, type ObligationCache, type Verdict } from './obligation-cache'

export type FileOutcome = {
  file: string
  ok: boolean
  // 'checked' = verified this run; 'cached' = skipped, reused a prior verdict
  source: 'checked' | 'cached'
  report?: Report
  backends?: Record<string, boolean>
}

export type IncrementalResult = {
  outcomes: FileOutcome[]
  checked: number
  cached: number
  ok: boolean
}

/** Verify a set of files, using the cache to skip unchanged ones. */
export function holdIncremental(input: {
  files: string[]
  resolve: Resolver
  cache: ObligationCache
  version: string
  cross?: boolean
  // ignore the cache and re-check everything (still records fresh verdicts)
  force?: boolean
}): IncrementalResult {
  const { files, resolve, cache, version } = input
  const cross = input.cross ?? true

  const outcomes: FileOutcome[] = []
  let checked = 0
  let cached = 0

  for (const file of files) {
    const source = readFileSync(file, 'utf8')

    // fold every loaded module's text into the key so a dependency edit invalidates this file's verdict
    let deps: string[] = []
    try {
      deps = collectModules({ file, text: source }, resolve).sources.map(s => s.text)
    } catch {
      deps = [source]
    }
    const key = obligationKey({ source, deps, version })

    if (!input.force) {
      const hit = cache.get(key)
      if (hit) {
        cached++
        outcomes.push({ file, ok: hit.ok, source: 'cached', backends: hit.backends })
        continue
      }
    }

    const report = proveFile({ file, resolve, cross })
    const verdict: Verdict = { ok: report.ok, label: file, backends: report.backends }
    cache.set(key, verdict)
    checked++
    outcomes.push({ file, ok: report.ok, source: 'checked', report, backends: report.backends })
  }

  cache.save()

  return {
    outcomes,
    checked,
    cached,
    ok: outcomes.every(o => o.ok),
  }
}
