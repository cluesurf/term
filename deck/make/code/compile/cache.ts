// Incremental compile cache. Two levels, both keyed by source content (not file mtime), so a file that is touched
// but unchanged is a cache hit, and an edit that reverts to a prior state reuses that state:
//   - mill level: the parse + template-expand + mill of a single module. Reused across compiles when its text is
//     unchanged, even if other modules in the graph changed. Fine-grained, so the persisted entries are small.
//   - output level: the whole compiled result for an exact module graph. A re-save with no edits returns instantly.
// Persistence is OPTIONAL and injected as a `CacheStore`, so the browser path stays pure while a node CLI can back the
// cache with `.base/@term/code/cache` (see code/call/cache-store.ts). Keys fold in a version, so a toolchain change
// never serves a stale hit.
//
// THE STATE AND EVERY DECISION ARE TERM, compile/cache-store.tree (item term-self-host-001-0107): the three maps, the
// counters, the least-recently-used order, every key, and the memoized text hash. This file is the face. It keeps the
// `CompileCache` API its callers construct, and only what Term cannot hold, handed to the port as `cache-io`: the
// store, the entry's JSON (`JSON.stringify` with the bigint tag, `JSON.parse` with the reviver and the shape test, so
// the bytes on disk are the original's, spec.md 4.15), and the clone a milled unit is handed back as.

import type { Program, Twin } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import {
  contentHash as contentHashPort,
  hashFields as hashFieldsPort,
  makeCompileCache,
  makeTextHashes,
  milledUnit as milledUnitPort,
  output as outputPort,
  scanned as scannedPort,
  versionFor,
} from '@term/make/code/compile/cache-store'
import type { CompileCache as CacheState } from '@term/make/code/compile/cache-store'

// the cache format epoch. Bump to invalidate every persisted entry at once (turborepo's `global_cache_key`). Change
// this on any change to the cached value shape or the mill/compile pipeline that the per-entry key does not capture.
//
// WHICH READER produced an entry is part of the epoch, because the mill cache is SHARED across projects and
// processes (~/.base/@term/code/base/mill). While the grammar reader was being brought up behind
// `TERM_MILL_GRAMMAR=1`, a run under the flag wrote its answers, diagnostics included, under keys the ordinary
// build then read back: a green board turned into six broken packages that no source change explained, and the
// errors named a reader that was not running. A cache key has to cover everything that changes the answer.
//
// `7` is the grammar reader (mint-bridge-0004, 2026-09-01). There is one reader again, so the epoch is a plain
// number again, and the bump is what retires every entry the hand-written one left behind.
//
// `8` is the lean surface (note/project/term/mill/lean.md, 2026-09-12): the bridge partitions a marked construct's
// arguments, `mine task` reads an anonymous task's name with `mine word`, a bare path operand is a member
// read, `void` is the literal in an open call's arguments, and the open call folds builtins. Every one changes
// what a unit mills to with its text unchanged, and the Sanskrit port spent an hour on `term make` reporting
// errors the source no longer had before the key was read. lean-0034 is keying this on the build itself.
// '9': an integer literal past 2^53 mills to an exact bigint instead of a rounded number, so a unit cached at '8'
// may hold a literal that names a different integer than its text.
// '10': every unit key, name key and surface hash is node-json's declared form, not `JSON.stringify` (decision 034,
// item term-self-host-001-0282), so every stored key changes once.
// '11': a stub's carried shape and body name each task in the names its module wrote (compile/stub.ts `carried`,
// items term-self-host-001-0323 and 0324), not its own unit's split names, so a unit stored at '10' may hold a stub
// whose carried call names another file's task in the unit reading it.
// The port to Term (item 0107) changes no key and no stored byte, so it keeps '11'.
export const CACHE_EPOCH = '11'

// A cached entry, or nothing. A CORRUPT ENTRY IS A MISS, never a crash: the store writes atomically, but a
// full disk, a killed process on a filesystem that does not honour the rename, or a half-synced network share
// can still leave a truncated file, and `JSON.parse` on one throws `Unexpected end of JSON input` out of the
// middle of a build. That is what a cache is least allowed to do, because the build was going to recompute the
// value anyway and the error names the cache rather than anything the author wrote.
// a bigint (an integer literal past 2^53) is stored tagged, the way program-json.ts renders it, since JSON has no
// integer wider than a double and `Number()` would store a different integer
const BIGINT_TAG = '$bigint'

export function storeBigint(_key: string, value: unknown): unknown {
  return typeof value === 'bigint'
    ? { [BIGINT_TAG]: value.toString() }
    : value
}

export function reviveBigint(_key: string, value: unknown): unknown {
  if (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value)
  ) {
    const tagged = (value as Record<string, unknown>)[BIGINT_TAG]

    if (typeof tagged === 'string' && Object.keys(value).length === 1) {
      return BigInt(tagged)
    }
  }

  return value
}

function readEntry<T>(
  stored: string | undefined,
  kind = 'output',
): T | undefined {
  if (stored === undefined) {
    return undefined
  }

  try {
    const value = JSON.parse(stored, reviveBigint) as unknown

    return usable(kind, value) ? (value as T) : undefined
  } catch {
    return undefined
  }
}

// WHETHER A STORED ENTRY HAS THE SHAPE ITS KIND READS (note/project/term/incremental-best-in-class.md, step 14). A torn or
// flipped entry fails gzip's checksum and a cut one fails to parse, and both are misses already. One that parses to the
// wrong shape, a `{}` where a unit's build belongs, was handed back as a hit, and the first read of a field it lacked
// crashed the build. It is a miss too, and the build that follows writes a good entry over it
function usable(kind: string, value: unknown): boolean {
  if (value === null || typeof value !== 'object') {
    return false
  }

  const entry = value as Record<string, unknown>

  switch (kind) {
    case 'mill':
      return (
        typeof entry.ok === 'boolean' &&
        (entry.ok
          ? Array.isArray(entry.program)
          : Array.isArray(entry.diagnostics))
      )
    case 'scan':
      return Array.isArray(entry.paths) && Array.isArray(entry.finds)
    case 'unit':
      // stored with each deck's root as a token (compile/separate.ts `portableBy`), read back by the build
      return typeof entry.portable === 'string'
    default:
      return true
  }
}

// A stored import scan, read back as it was built. JSON writes an `undefined` in an array as `null`, and a scan's
// `aliases` holds `undefined` for every `find` with no `name`, so read back plainly each one became an alias called
// `null` and the module's imports bound nothing (`the name "replace" is not defined`, found by the dev-loop bench on
// 2026-10-05). A scan holds no `null` of its own, so every one is an `undefined` that was written
function readScan<T>(stored: string | undefined): T | undefined {
  if (stored === undefined) {
    return undefined
  }

  try {
    const value = JSON.parse(stored, (_key, value: unknown) =>
      value === null ? undefined : value,
    ) as unknown

    return usable('scan', value) ? (value as T) : undefined
  } catch {
    return undefined
  }
}

// THE CONTENT HASH IS TERM: `hashText` is deck/make/code/term/hash.tree, and the key of every field list and the memo
// of each text's hash are compile/cache-store.tree. The memo is the process's one `text-hashes` record, shared by
// every cache, bounded by the size of the texts it holds.
const TEXT_HASHES = makeTextHashes()

// join fields into one hash input with length prefixes, so no concatenation is ambiguous (`a` + `bc` cannot collide
// with `ab` + `c`). Use for any composite key.
export function hashFields(fields: string[]): string {
  return hashFieldsPort(fields)
}

// THE HASH OF A MODULE'S TEXT, ONCE PER PROCESS
export function contentHash(text: string): string {
  return contentHashPort(TEXT_HASHES, text)
}

// the milled output of one module: a program, or the diagnostics that stopped it
export type MilledUnit =
  // `twins` beside the program (node.ts, `Twin`): a cached unit that dropped them would build as if they were never
  // written, which is correct but loses them
  | { ok: true; program: Program; twins?: Twin[] }
  | { ok: false; diagnostics: Diagnostic[] }

// a persistent backend for the cache. `kind` separates namespaces (`mill` / `output`). Synchronous and string-valued,
// so the in-memory cache stays simple. A node implementation reads / writes `.base/@term/code/cache`; the browser passes none.
export type CacheStore = {
  load(kind: string, key: string): string | undefined
  save(kind: string, key: string, value: string): void
}

// The LRU caps (compile/cache-store.tree holds the order). `outputs` grows once PER ENTRY FILE and was the whole
// retained heap at roughly 370 KB an entry (measured on @term/bind at 400 of its 3,091 files: both caches 172 MB,
// outputs cleared 29 MB), with a hit rate of zero in a project build, so its cap is small. `mills` is keyed by module,
// bounded by the graph, about 3.5 KB an entry. Neither cap can change a result.
export const MILL_CACHE_CAP = 8192
export const OUTPUT_CACHE_CAP = 32

function cloneUnit(unit: MilledUnit): MilledUnit {
  return unit.ok
    ? {
        ok: true,
        program: structuredClone(unit.program),
        ...(unit.twins ? { twins: structuredClone(unit.twins) } : {}),
      }
    : unit
}

export class CompileCache {
  // the port's record: the three maps, the counters, the caps and the injected host IO
  readonly state: CacheState

  // `store` persists entries across processes (optional). `version` is folded into every key (the compiler version +
  // epoch), so an upgraded toolchain invalidates everything without a manual wipe. A string versions every kind
  // alike; a function gives each its own, which stops a change only the output level can see from also changing
  // every mill KEY. The caps are overridable so a test can force eviction without building thousands of modules.
  constructor(
    store?: CacheStore,
    version: string | ((kind: string) => string) = CACHE_EPOCH,
    millCap: number = MILL_CACHE_CAP,
    outputCap: number = OUTPUT_CACHE_CAP,
  ) {
    this.state = makeCompileCache(
      {
        versionOf:
          typeof version === 'string' ? () => version : version,
        readEntry: (kind: string, key: string, shape: string) => {
          const stored = store?.load(kind, key)
          const value =
            shape === 'scan'
              ? readScan<unknown>(stored)
              : readEntry<unknown>(stored, shape)

          return value === undefined
            ? { form: 'none' }
            : { form: 'some', value }
        },
        writeEntry: (kind: string, key: string, value: unknown) => {
          store?.save(kind, key, JSON.stringify(value, storeBigint))

          return true
        },
        cloneUnit: (unit: unknown) => cloneUnit(unit as MilledUnit),
      } as never,
      millCap,
      outputCap,
      TEXT_HASHES,
    )
  }

  // counters for observability (and tests): how often each level was reused vs rebuilt, split by tier
  get hits(): number {
    return this.state.hits
  }

  get misses(): number {
    return this.state.misses
  }

  get diskHits(): number {
    return this.state.diskHits
  }

  // the compiler's fingerprint for one kind, which `term make --explain` reports when it moved
  versionOf(kind: string): string {
    return versionFor(this.state, kind)
  }

  // the milled unit for (file, text): memory, then the store, then built, handed back as a fresh clone
  milledUnit(
    file: string,
    text: string,
    build: () => MilledUnit,
  ): MilledUnit {
    return milledUnitPort(this.state, file, text, build) as MilledUnit
  }

  // what a module's text imports (its `load` lines), for the module walk, stored beside the mill entries
  scanned<T>(file: string, text: string, build: () => T): T {
    return scannedPort(this.state, file, text, build) as T
  }

  // one unit of the separate build (compile/separate.ts), under its own kind, which the store keeps machine-wide
  unit<T>(key: string, build: () => T): T {
    return this.output(key, build, 'unit')
  }

  // the whole compiled output for a graph key. The value must be JSON-serializable
  output<T>(key: string, build: () => T, kind = 'output'): T {
    return outputPort(this.state, key, build, kind) as T
  }
}
