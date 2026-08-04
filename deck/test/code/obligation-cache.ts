/**
 * The obligation cache: don't re-verify what hasn't changed. A
 * verification result (an obligation discharged, or refuted) is keyed by
 * a content hash of everything that could change the verdict - the
 * source, its dependencies, and the toolchain version - so an unchanged
 * function is never re-checked, and any real change invalidates the
 * entry automatically (the "compiler version in the key" lesson from
 * incremental build systems).
 *
 * This is synthesis.md Phase F (and the scale lever for running `seed
 * hold` over seed/ itself): the first run checks everything; later runs
 * only re-check what moved.
 *
 * Two layers, like the compiler's own cache:
 *   - a pure `ObligationCache` (get/set over string keys) - browser-safe,
 *     no fs, the unit the verifier talks to.
 *   - `diskObligationCache(dir)` - a node-backed store that persists the
 *     map as one JSON file under `.base/term/hold`, loaded once and flushed
 *     on `save()`. Writes are atomic (temp then rename).
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs'
import path from 'node:path'
import { hashText } from '@term/make/code/compile/cache'

/** The recorded outcome of a verification, small and serializable. */
export type Verdict = {
  ok: boolean
  // a short label for what was checked (e.g. the file path), for reporting
  label: string
  // the cross-backend results at the time it was cached, if run
  backends?: Record<string, boolean>
}

/** The unit the verifier talks to: look up and record verdicts by key. */
export type ObligationCache = {
  get(key: string): Verdict | undefined
  set(key: string, verdict: Verdict): void
  // persist any pending writes (no-op for the in-memory cache)
  save(): void
  // number of live entries
  size(): number
}

/**
 * Build the cache key for one verification obligation. Everything that
 * could change the verdict goes in: the source text, the (sorted)
 * dependency source texts, and the toolchain version. Change any byte of
 * any of them and the key changes, so the cached verdict is dropped.
 */
export function obligationKey(input: {
  source: string
  deps?: string[]
  version: string
}): string {
  const deps = (input.deps ?? []).slice().sort()
  // hash each part, then hash the concatenation, so a long dep list stays a short key
  const parts = [hashText(input.source), hashText(input.version), ...deps.map(hashText)]
  return hashText(parts.join(':'))
}

/** An in-memory cache (no persistence) - useful in tests and the browser. */
export function memoryObligationCache(): ObligationCache {
  const map = new Map<string, Verdict>()
  return {
    get: key => map.get(key),
    set: (key, verdict) => void map.set(key, verdict),
    save: () => {},
    size: () => map.size,
  }
}

/**
 * A disk-backed obligation cache rooted at `dir` (e.g.
 * `<project>/.base/term/hold`). The whole map is one JSON file, loaded once
 * at construction and flushed on `save()`. A corrupt or missing file is
 * treated as an empty cache (a cache must never fail the verifier).
 */
export function diskObligationCache(dir: string): ObligationCache {
  const file = path.join(dir, 'obligations.json')
  const map = new Map<string, Verdict>()
  let dirty = false

  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8')) as Record<string, Verdict>
    for (const [key, verdict] of Object.entries(parsed)) map.set(key, verdict)
  } catch {
    // missing or corrupt: start empty
  }

  return {
    get: key => map.get(key),
    set: (key, verdict) => {
      map.set(key, verdict)
      dirty = true
    },
    size: () => map.size,
    save: () => {
      if (!dirty) return
      try {
        mkdirSync(dir, { recursive: true })
        const temp = `${file}.${process.pid}.tmp`
        writeFileSync(temp, JSON.stringify(Object.fromEntries(map), null, 0))
        renameSync(temp, file)
        dirty = false
      } catch {
        // a cache write failure must never fail the verifier
      }
    },
  }
}
