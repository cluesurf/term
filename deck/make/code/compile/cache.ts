// Incremental compile cache. Two levels, both keyed by source content (not file mtime), so a file that is touched
// but unchanged is a cache hit, and an edit that reverts to a prior state reuses that state:
//   - mill level: the parse + template-expand + mill of a single module. Reused across compiles when its text is
//     unchanged, even if other modules in the graph changed. Fine-grained, so the persisted entries are small.
//   - output level: the whole compiled result for an exact module graph. A re-save with no edits returns instantly.
// The in-memory path is pure and browser-safe (a pure-JS content hash, no node:crypto). Persistence is OPTIONAL and
// injected as a `CacheStore`, so the browser path stays pure while a node CLI can back the cache with `.base/term/cache`
// (see code/call/cache-store.ts). Keys fold in a version, so a toolchain change never serves a stale hit.
// See note/research/repo/turborepo/07-lessons-for-seed.md and note/seed/plan/compilation-performance.md (Tier 1).

import type { Program } from '@cluesurf/make/code/compile/node'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'

// the cache format epoch. Bump to invalidate every persisted entry at once (turborepo's `global_cache_key`). Change
// this on any change to the cached value shape or the mill/compile pipeline that the per-entry key does not capture.
export const CACHE_EPOCH = '3'

// cyrb53: a fast, well-distributed 53-bit string hash. A collision only ever causes a stale reuse (never a crash),
// and at 53 bits that is astronomically unlikely for a source tree.
export function hashText(text: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57

  for (let i = 0; i < text.length; i++) {
    const ch = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }

  h1 =
    Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^
    Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 =
    Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^
    Math.imul(h1 ^ (h1 >>> 13), 3266489909)

  return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36)
}

// join fields into one hash input with length prefixes, so no concatenation is ambiguous (`a` + `bc` cannot collide
// with `ab` + `c`). Use for any composite key.
export function hashFields(fields: string[]): string {
  return hashText(fields.map(f => `${f.length}:${f}`).join(''))
}

// the milled output of one module: a program, or the diagnostics that stopped it
export type MilledUnit =
  | { ok: true; program: Program }
  | { ok: false; diagnostics: Diagnostic[] }

// a persistent backend for the cache. `kind` separates namespaces (`mill` / `output`). Synchronous and string-valued,
// so the in-memory cache stays simple. A node implementation reads / writes `.base/term/cache`; the browser passes none.
export interface CacheStore {
  load(kind: string, key: string): string | undefined
  save(kind: string, key: string, value: string): void
}

export class CompileCache {
  private readonly mills = new Map<string, MilledUnit>()
  private readonly outputs = new Map<string, unknown>()
  // counters for observability (and tests): how often each level was reused vs rebuilt, split by tier
  hits = 0
  misses = 0
  diskHits = 0

  // `store` persists entries across processes (optional). `version` is folded into every key (the compiler version +
  // epoch), so an upgraded toolchain invalidates everything without a manual wipe.
  constructor(
    private readonly store?: CacheStore,
    private readonly version: string = CACHE_EPOCH,
  ) {}

  // the milled unit for (file, text). Looks in memory, then the persistent store, then builds. Stores on a build.
  // Returns a fresh clone of the program so the caller may annotate / rewrite the AST (the checker does) without
  // corrupting the cached copy.
  milledUnit(
    file: string,
    text: string,
    build: () => MilledUnit,
  ): MilledUnit {
    const key = hashFields([this.version, file, hashText(text)])
    const cached = this.mills.get(key)

    if (cached) {
      this.hits++

      return cloneUnit(cached)
    }

    const stored = this.store?.load('mill', key)

    if (stored !== undefined) {
      const unit = JSON.parse(stored) as MilledUnit
      this.mills.set(key, unit)
      this.diskHits++

      return cloneUnit(unit)
    }

    this.misses++

    const fresh = build()
    this.mills.set(key, fresh)
    this.store?.save('mill', key, JSON.stringify(fresh))

    return cloneUnit(fresh)
  }

  // the whole compiled output for a graph key. Looks in memory, then the store, then builds. The value must be
  // JSON-serializable (the compile result is: program AST + emitted text + diagnostics).
  output<T>(key: string, build: () => T): T {
    const versioned = hashFields([this.version, key])
    const cached = this.outputs.get(versioned) as T | undefined

    if (cached !== undefined) {
      this.hits++

      return cached
    }

    const stored = this.store?.load('output', versioned)

    if (stored !== undefined) {
      const value = JSON.parse(stored) as T
      this.outputs.set(versioned, value)
      this.diskHits++

      return value
    }

    this.misses++

    const fresh = build()
    this.outputs.set(versioned, fresh)
    this.store?.save('output', versioned, JSON.stringify(fresh))

    return fresh
  }
}

function cloneUnit(unit: MilledUnit): MilledUnit {
  return unit.ok
    ? { ok: true, program: structuredClone(unit.program) }
    : unit
}
