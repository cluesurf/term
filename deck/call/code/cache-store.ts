// A node-backed persistent cache store for the compiler (Tier 1). Reads / writes JSON entries under `.seed/cache`, so a
// cold `seed boot` / `seed make` reuses the parse + mill + compile work of a prior run. Writes are atomic (temp file
// then rename), so a killed build never leaves a truncated entry a later run would trust. Injected into `CompileCache`,
// which keeps its own logic browser-safe. See note/seed/plan/compilation-performance.md (Tier 1).

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
} from 'fs'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'
import type { CacheStore } from '@cluesurf/make/code/compile/cache'
import {
  CACHE_EPOCH,
  CompileCache,
} from '@cluesurf/make/code/compile/cache'

// a disk-backed cache store rooted at `dir` (e.g. `<project>/.seed/cache`). One subdir per kind, one file per key.
export function diskCacheStore(dir: string): CacheStore {
  const ensured = new Set<string>()
  const dirFor = (kind: string): string => {
    const sub = path.join(dir, kind)
    if (!ensured.has(sub)) {
      mkdirSync(sub, { recursive: true })
      ensured.add(sub)
    }
    return sub
  }
  return {
    load(kind, key) {
      const file = path.join(dir, kind, `${key}.json`)
      try {
        return readFileSync(file, 'utf8')
      } catch {
        return undefined
      }
    },
    save(kind, key, value) {
      const file = path.join(dirFor(kind), `${key}.json`)
      // atomic: write a unique temp then rename over the target (rename is atomic on the same filesystem)
      const temp = `${file}.${process.pid}.${tempCounter++}.tmp`
      try {
        writeFileSync(temp, value)
        renameSync(temp, file)
      } catch {
        // a cache write failure must never fail the build
      }
    },
  }
}
let tempCounter = 0

// the running compiler's version, read from the seed package's own package.json (works whether the CLI runs from
// source via tsx or from the bundled `host/`). Memoized. Folded into every cache key so a toolchain upgrade
// invalidates the cache automatically (the turborepo "compiler version in the key" lesson), alongside the epoch.
let cachedVersion: string | undefined
export function compilerVersion(): string {
  if (cachedVersion !== undefined) return cachedVersion
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const manifest = path.join(dir, 'package.json')
    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string
          version?: string
        }
        if (pkg.name === '@cluesurf/seed.tree') {
          cachedVersion = `${CACHE_EPOCH}:${pkg.version ?? '0'}`
          return cachedVersion
        }
      } catch {
        // keep walking up
      }
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  cachedVersion = CACHE_EPOCH
  return cachedVersion
}

// the machine-wide shared cache home (Tier 5). Mill entries are content + path addressed, and linked stdlib files
// share a realpath across projects, so the stdlib is milled once for every project on the machine. Overridable for
// tests / CI via SEED_CACHE_HOME.
export function cacheHome(): string {
  return (
    process.env.SEED_CACHE_HOME ??
    path.join(os.homedir(), '.seed', 'store')
  )
}

// a store that routes the per-module `mill` level to a shared dir (reused across projects) and the whole-graph
// `output` level to the project-local dir (a graph is project-specific). The big win is cross-project mill reuse.
export function sharedCacheStore(
  localDir: string,
  sharedDir: string,
): CacheStore {
  const local = diskCacheStore(localDir)
  const shared = diskCacheStore(sharedDir)
  const storeFor = (kind: string): CacheStore =>
    kind === 'mill' ? shared : local
  return {
    load: (kind, key) => storeFor(kind).load(kind, key),
    save: (kind, key, value) => storeFor(kind).save(kind, key, value),
  }
}

// a persistent compile cache for a project: per-module mills shared machine-wide, the project's compiled output local.
// Versioned by the compiler, so a toolchain upgrade invalidates everything. The call sites use this.
export function projectCache(projectRoot: string): CompileCache {
  return new CompileCache(
    sharedCacheStore(
      path.join(projectRoot, '.seed', 'cache'),
      cacheHome(),
    ),
    compilerVersion(),
  )
}
