// Incremental compile cache. Two levels, both keyed by source content (not file mtime), so a file that is touched
// but unchanged is a cache hit, and an edit that reverts to a prior state reuses that state:
//   - mill level: the parse + template-expand + mill of a single module. Reused across compiles when its text is
//     unchanged, even if other modules in the graph changed. Fine-grained, so the persisted entries are small.
//   - output level: the whole compiled result for an exact module graph. A re-save with no edits returns instantly.
// The in-memory path is pure and browser-safe (a pure-JS content hash, no node:crypto). Persistence is OPTIONAL and
// injected as a `CacheStore`, so the browser path stays pure while a node CLI can back the cache with `.base/@cluesurf/term/cache`
// (see code/call/cache-store.ts). Keys fold in a version, so a toolchain change never serves a stale hit.
// See note/research/repo/turborepo/07-lessons-for-seed.md and note/seed/plan/compilation-performance.md (Tier 1).

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'

// the cache format epoch. Bump to invalidate every persisted entry at once (turborepo's `global_cache_key`). Change
// this on any change to the cached value shape or the mill/compile pipeline that the per-entry key does not capture.
//
// WHICH READER produced an entry is part of the epoch, because the mill cache is SHARED across projects and
// processes (~/.base/@cluesurf/term/store/mill). While the grammar reader was being brought up behind
// `TERM_MILL_GRAMMAR=1`, a run under the flag wrote its answers, diagnostics included, under keys the ordinary
// build then read back: a green board turned into six broken packages that no source change explained, and the
// errors named a reader that was not running. A cache key has to cover everything that changes the answer.
//
// `7` is the grammar reader (mint-bridge-0004, 2026-09-01). There is one reader again, so the epoch is a plain
// number again, and the bump is what retires every entry the hand-written one left behind.
export const CACHE_EPOCH = '7'

// A cached entry, or nothing. A CORRUPT ENTRY IS A MISS, never a crash: the store writes atomically, but a
// full disk, a killed process on a filesystem that does not honour the rename, or a half-synced network share
// can still leave a truncated file, and `JSON.parse` on one throws `Unexpected end of JSON input` out of the
// middle of a build. That is what a cache is least allowed to do, because the build was going to recompute the
// value anyway and the error names the cache rather than anything the author wrote.
function readEntry<T>(stored: string | undefined): T | undefined {
  if (stored === undefined) {
    return undefined
  }

  try {
    return JSON.parse(stored) as T
  } catch {
    return undefined
  }
}

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
// so the in-memory cache stays simple. A node implementation reads / writes `.base/@cluesurf/term/cache`; the browser passes none.
export interface CacheStore {
  load(kind: string, key: string): string | undefined
  save(kind: string, key: string, value: string): void
}

// Least-recently-used eviction over a Map, which already keeps insertion order: a hit re-inserts the key to make it
// most-recent, and a set evicts from the front once the cap is passed.
//
// WHY THE CAPS EXIST. Both maps used to grow without limit for the life of a build, and `outputs` grows once PER
// ENTRY FILE. Measured on @term/bind at 400 of its 3,091 files, retained heap after a forced GC:
//
//   both caches   172 MB          outputs cleared    29 MB
//   mills cleared 178 MB          neither            23 MB
//
// So `outputs` was the whole retained heap, at roughly 370 KB an entry, and it is the term that scales with the
// PROJECT rather than with the module graph: at 3,091 files it exhausted an 8 GB heap, and at a hundred thousand it
// would want terabytes. Its hit rate in a project build is ZERO by construction, because compileProject visits each
// entry exactly once and each entry has its own graph key (the 400 files produced 400 entries and no reuse). It pays
// off only in watch mode and repeated compiles of the same entry, which a small cap serves just as well.
//
// `mills` is keyed by MODULE, so it is bounded by the graph rather than the project (1,694 entries for those same
// 400 files) and costs about 3.5 KB an entry. Its cap is large enough to hold a realistic closure and exists only so
// that nothing is unbounded.
//
// Neither cap can change a result. Everything either map holds is rebuildable, and the persistent store still
// carries reuse across runs.
function evictTo<K, V>(map: Map<K, V>, cap: number): void {
  while (map.size > cap) {
    const oldest = map.keys().next()

    if (oldest.done) {
      return
    }

    map.delete(oldest.value)
  }
}

function touch<K, V>(map: Map<K, V>, key: K, value: V): void {
  map.delete(key)
  map.set(key, value)
}

export const MILL_CACHE_CAP = 8192
export const OUTPUT_CACHE_CAP = 32

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
    // the LRU caps, overridable so a test can force eviction without building thousands of modules
    private readonly millCap: number = MILL_CACHE_CAP,
    private readonly outputCap: number = OUTPUT_CACHE_CAP,
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
      touch(this.mills, key, cached)

      return cloneUnit(cached)
    }

    const unit = readEntry<MilledUnit>(this.store?.load('mill', key))

    if (unit !== undefined) {
      this.mills.set(key, unit)
      evictTo(this.mills, this.millCap)
      this.diskHits++

      return cloneUnit(unit)
    }

    this.misses++

    const fresh = build()
    this.mills.set(key, fresh)
    evictTo(this.mills, this.millCap)
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
      touch(this.outputs, versioned, cached)

      return cached
    }

    const value = readEntry<T>(this.store?.load('output', versioned))

    if (value !== undefined) {
      this.outputs.set(versioned, value)
      evictTo(this.outputs, this.outputCap)
      this.diskHits++

      return value
    }

    this.misses++

    const fresh = build()
    this.outputs.set(versioned, fresh)
    evictTo(this.outputs, this.outputCap)
    this.store?.save('output', versioned, JSON.stringify(fresh))

    return fresh
  }
}

function cloneUnit(unit: MilledUnit): MilledUnit {
  return unit.ok
    ? { ok: true, program: structuredClone(unit.program) }
    : unit
}
