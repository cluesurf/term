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
import path from 'path'
import { fileURLToPath } from 'url'
import type { CacheStore } from '../compile/cache'
import { CACHE_EPOCH, CompileCache } from '../compile/cache'

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

// a persistent compile cache rooted at a project's `.seed/cache`, versioned by the compiler. The call sites use this.
export function projectCache(projectRoot: string): CompileCache {
  return new CompileCache(
    diskCacheStore(path.join(projectRoot, '.seed', 'cache')),
    compilerVersion(),
  )
}
