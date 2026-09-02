// A node-backed persistent cache store for the compiler (Tier 1). Reads / writes entries under
// `.base/@cluesurf/term/cache`, so a cold `term boot` / `term make` reuses the parse + mill + compile work of a prior
// run. Writes are atomic (temp file then rename), so a killed build never leaves a truncated entry a later run would
// trust. Injected into `CompileCache`, which keeps its own logic browser-safe.
//
// THE LAYOUT IS `<kind>/<version>/<shard>/<key>.json.gz`, AND EVERY PART OF THAT PATH IS LOAD-BEARING.
//
// It used to be `<kind>/<key>.json`, flat and uncompressed, with the version folded into the key hash and nothing
// ever removed. Measured on 2026-09-01, that cost **101 GB across the tree**, 86 GB of it in `deck/bind`, in
// 143,604 files in ONE directory. The three reasons, each fixed by one part of the path:
//
// **`<version>`: a compiler change strands the whole cache, and nothing reclaimed it.** The version is a content
// hash of the running compiler, so every rebuild opens a new namespace and every entry written under the old one
// becomes unreachable forever. `deck/seed` held 20,216 output entries for a 532-file package: 38 stranded copies per
// file, 97% of it dead. Making the version a DIRECTORY rather than a fold into the key means a stale namespace is a
// directory to remove, which `reclaimStaleVersions` does on startup, keeping `KEEP_VERSIONS` of them so switching
// between two binaries does not cold-start either.
//
// **`<shard>`: 143,604 files in one directory** is a cost paid continuously by a machine that is not even building.
// Every `readdir`, every Spotlight pass and every Time Machine run walks all of them. Two characters of the key is
// the usual shape and bounds a directory at a few hundred.
//
// **`.gz`: entries compress 13.1x.** Measured over 25 random entries of `deck/bind`: 16.9 MB raw to 1.29 MB gzipped,
// 7.6% of the size. The value is a serialised AST, which is the most compressible thing there is, and gzip on a
// 600 KB entry costs a few milliseconds against the whole-file compile it saves.
//
// Together those take `deck/bind`'s 73 GB output cache to roughly a hundred megabytes, and it stays there because
// `enforceBudget` holds each kind under a byte budget by dropping the least recently used.
//
// THE CACHE IS WORTH HAVING, which is worth stating because the size made it look otherwise. Measured the same day
// on `deck/seed`, 532 files, second build of identical sources: **5.8s to 2.9s**, with the output level answering
// 532 of 532 reads and writing nothing. An output hit short-circuits the entire pipeline for that entry, which is
// why it is the level that matters and the level that grew.

import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  renameSync,
  existsSync,
  readdirSync,
  lstatSync,
  rmSync,
  unlinkSync,
} from 'fs'
import { gzipSync, gunzipSync } from 'zlib'
import path from 'path'
import { fileURLToPath } from 'url'
import type { CacheStore } from '@term/make/code/compile/cache'
import { env, userHome } from '@term/call/code/home'
import {
  CACHE_EPOCH,
  CompileCache,
  hashText,
} from '@term/make/code/compile/cache'
import { CACHE_SCOPE } from '@term/make/code/compile/cache-scope.generated'

// How many compiler versions keep their entries. The current one plus one, so alternating between two binaries (a
// rebuilt `host/line.js` and the one before it, or two branches) does not cold-start either. A third is already
// paying for a compiler nobody is running.
export const KEEP_VERSIONS = 2

// The byte budget per kind, enforced once per process against the CURRENT version's directory. Generous on purpose:
// with the layout above, `deck/bind`'s live output namespace is about a hundred megabytes and `deck/seed`'s is under
// one, so a project that trips this is doing something the author should hear about rather than something routine.
export const OUTPUT_BUDGET_BYTES = 2 * 1024 * 1024 * 1024
export const MILL_BUDGET_BYTES = 4 * 1024 * 1024 * 1024

export function budgetFor(kind: string): number {
  return kind === 'mill' ? MILL_BUDGET_BYTES : OUTPUT_BUDGET_BYTES
}

// A version string to one filesystem-safe token. The version carries a `:` and a package version; hashing it keeps
// the path short and makes every namespace directory the same shape, which is what lets them be compared by mtime.
export function versionSlug(version: string): string {
  return hashText(version)
}

// two characters of the key. The keys are base-36 hashes, so this spreads evenly and bounds a directory at a few
// hundred entries for any realistic project.
function shardOf(key: string): string {
  return key.slice(0, 2) || '__'
}

// THE ONE PLACE THAT KNOWS WHERE AN ENTRY LIVES. Everything that reads or writes the cache goes through this
// (the store itself, the remote cache's push and pull, the report). `remote-cache.ts` used to build the path itself
// and kept working only while the layout never changed; the moment it did, push and pull silently moved zero
// artifacts and their tests said so. A second implementation of a layout disagrees with the layout eventually.
export function entryPath(
  dir: string,
  kind: string,
  version: string,
  key: string,
): string {
  return entryPathBySlug(dir, kind, versionSlug(version), key)
}

// the same, when the caller already holds the on-disk slug (the remote cache does: it moves entries between machines
// without knowing which compiler wrote them, so it must never re-hash a version it did not produce)
export function entryPathBySlug(
  dir: string,
  kind: string,
  slug: string,
  key: string,
): string {
  return path.join(dir, kind, slug, shardOf(key), `${key}.json.gz`)
}

// Every entry an entry directory holds, addressed the way the layout addresses it: kind, version namespace, key.
// The remote cache indexes by this, so it never has to know the shape of the path.
//
// The version comes back as the SLUG on disk, not the version string it was hashed from, because that is what the
// address needs: a slug is what names the directory, and a puller has to put an entry back where its key expects it
// even when the entry came from a compiler that machine has never run.
export function storedEntries(
  dir: string,
  kinds: readonly string[],
): { kind: string; version: string; key: string }[] {
  const found: { kind: string; version: string; key: string }[] = []

  for (const kind of kinds) {
    for (const entry of cacheEntries(path.join(dir, kind))) {
      const name = path.basename(entry.file)

      if (!name.endsWith('.json.gz')) {
        continue
      }

      // `<dir>/<kind>/<version>/<shard>/<key>.json.gz`, so the version is two levels above the file
      const version = path.basename(path.dirname(path.dirname(entry.file)))

      found.push({
        kind,
        version,
        key: name.slice(0, -'.json.gz'.length),
      })
    }
  }

  return found
}

// Every file under `dir`, with its size and mtime. Used by the budget sweep and by the report tool, so both agree
// about what a cache holds.
//
// `lstat`, NEVER `stat`: a symlink is counted as the link and never followed. Following them made the first run of
// the report claim 1,557,034 files and 33.6 GB under `deck/zone`, which really holds 40,725 files and 1.9 GB. The 56
// symlinks in there point at package trees, and a walk that follows them measures those trees instead, over and
// over. A cache sweep that deletes by that measurement would delete the wrong thing.
export function cacheEntries(
  dir: string,
): { file: string; size: number; when: number }[] {
  const found: { file: string; size: number; when: number }[] = []

  const walk = (at: string): void => {
    let names: string[]

    try {
      names = readdirSync(at)
    } catch {
      return
    }

    for (const name of names) {
      const full = path.join(at, name)

      try {
        const stat = lstatSync(full)

        if (stat.isSymbolicLink()) {
          continue
        }

        if (stat.isDirectory()) {
          walk(full)
        } else {
          found.push({ file: full, size: stat.size, when: stat.mtimeMs })
        }
      } catch {
        // a file removed underneath the walk is not an error
      }
    }
  }

  walk(dir)

  return found
}

// The pre-rename cache directories of one project: `.base/term/cache` and any `cache.*` copy set aside beside it.
// NOT the whole of `.base/term`, which also holds `boot/` markers and other state that is not rebuildable. The
// difference is 12 MB of boot markers in `deck/zone` that a wholesale sweep would have taken with the cache.
export function legacyCacheDirs(projectRoot: string): string[] {
  const base = path.join(projectRoot, '.base/term')

  try {
    return readdirSync(base)
      .filter(name => name === 'cache' || name.startsWith('cache.'))
      .map(name => path.join(base, name))
      .filter(dir => {
        try {
          return lstatSync(dir).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

// The same for the CURRENT path: a `cache.*` copy set aside beside the live one is not the live cache and nothing
// reads it.
export function asideCacheDirs(projectRoot: string): string[] {
  const base = path.join(projectRoot, '.base/@cluesurf/term')

  try {
    return readdirSync(base)
      .filter(name => name.startsWith('cache.'))
      .map(name => path.join(base, name))
      .filter(dir => {
        try {
          return lstatSync(dir).isDirectory()
        } catch {
          return false
        }
      })
      .sort()
  } catch {
    return []
  }
}

// Remove every version namespace but the newest `keep`, always keeping `current`. A namespace is dead the moment the
// compiler that wrote it is replaced, and nothing else will ever ask for it.
export function reclaimStaleVersions(
  dir: string,
  kind: string,
  current: string,
  keep: number = KEEP_VERSIONS,
): string[] {
  const base = path.join(dir, kind)
  let names: string[]

  try {
    names = readdirSync(base)
  } catch {
    return []
  }

  const versions: { name: string; when: number }[] = []

  for (const name of names) {
    const full = path.join(base, name)

    try {
      const stat = lstatSync(full)

      // a FILE directly under the kind is an entry in the pre-2026-09-01 flat layout. It is unreadable now (the key
      // shape and the compression both changed), so it is dead weight and goes with the stale namespaces.
      if (!stat.isDirectory()) {
        removeQuietly(full)
        continue
      }

      versions.push({ name, when: stat.mtimeMs })
    } catch {
      // gone already
    }
  }

  const doomed = versions
    .filter(v => v.name !== current)
    .sort((a, b) => b.when - a.when)
    .slice(Math.max(0, keep - 1))

  for (const version of doomed) {
    removeQuietly(path.join(base, version.name))
  }

  return doomed.map(v => v.name)
}

// Hold one kind's CURRENT namespace under its byte budget by dropping the least recently used first. Everything a
// cache holds is rebuildable, so this can never change a result: the worst case is a slower next build.
export function enforceBudget(
  dir: string,
  kind: string,
  slug: string,
  budget: number = budgetFor(kind),
): { removed: number; freed: number } {
  const base = path.join(dir, kind, slug)
  const entries = cacheEntries(base)
  let total = entries.reduce((n, e) => n + e.size, 0)

  if (total <= budget) {
    return { removed: 0, freed: 0 }
  }

  let removed = 0
  let freed = 0

  for (const entry of entries.sort((a, b) => a.when - b.when)) {
    if (total <= budget) {
      break
    }

    if (removeQuietly(entry.file)) {
      total -= entry.size
      freed += entry.size
      removed++
    }
  }

  return { removed, freed }
}

function removeQuietly(target: string): boolean {
  try {
    rmSync(target, { recursive: true, force: true })

    return true
  } catch {
    return false
  }
}

// a disk-backed cache store rooted at `dir` (e.g. `<project>/.base/@cluesurf/term/cache`), namespaced by the
// compiler `version` so a stale namespace can be reclaimed whole. Entries are gzipped.
// `version` is a string for one namespace across every kind, or a function for a namespace PER KIND. The per-kind
// form is what the compiler uses: see compilerSourceHash for why one namespace for everything strands the whole
// cache on any compiler change.
export function diskCacheStore(
  dir: string,
  version: string | ((kind: string) => string),
): CacheStore {
  const slugs = new Map<string, string>()
  const slugFor = (kind: string): string => {
    const already = slugs.get(kind)

    if (already !== undefined) {
      return already
    }

    const slug = versionSlug(
      typeof version === 'string' ? version : version(kind),
    )
    slugs.set(kind, slug)

    return slug
  }

  const ensured = new Set<string>()
  // reclamation and the budget sweep are per (dir, kind) and cost a directory walk, so each runs once per process
  const swept = new Set<string>()

  const sweep = (kind: string): void => {
    if (swept.has(kind)) {
      return
    }

    swept.add(kind)

    try {
      reclaimStaleVersions(dir, kind, slugFor(kind))
      enforceBudget(dir, kind, slugFor(kind))
    } catch {
      // housekeeping must never fail a build
    }
  }

  const dirFor = (kind: string, key: string): string => {
    const sub = path.join(dir, kind, slugFor(kind), shardOf(key))

    if (!ensured.has(sub)) {
      mkdirSync(sub, { recursive: true })
      ensured.add(sub)
    }

    return sub
  }

  return {
    load(kind, key) {
      sweep(kind)

      try {
        return gunzipSync(
          readFileSync(entryPathBySlug(dir, kind, slugFor(kind), key)),
        ).toString('utf8')
      } catch {
        // absent, unreadable, or written by an older layout: all of them are a miss, never a crash
        return undefined
      }
    },
    save(kind, key, value) {
      sweep(kind)

      const file = path.join(dirFor(kind, key), `${key}.json.gz`)
      // atomic: write a unique temp then rename over the target (rename is atomic on the same filesystem)
      const temp = `${file}.${process.pid}.${tempCounter++}.tmp`

      try {
        writeFileSync(temp, gzipSync(Buffer.from(value, 'utf8'), { level: 6 }))
        renameSync(temp, file)
      } catch {
        // a cache write failure must never fail the build
        try {
          unlinkSync(temp)
        } catch {
          // the temp may not exist
        }
      }
    },
  }
}

let tempCounter = 0

// the running compiler's fingerprint, folded into every cache key. It combines the cache-format epoch, the package
// version, AND a content fingerprint of the actual compiler -- so ANY change to the compiler invalidates the cache
// automatically, with no manual epoch bump. This is what makes a stale hit impossible: the key tracks the code that
// produced the value, not just a hand-maintained version string. Memoized, so it costs one walk per process.

// The directories that ARE the compiler, relative to the PACKAGE ROOT. A change to any `.ts` under them changes what
// a compile produces.
//
// RELATIVE TO THE PACKAGE ROOT, never to this file. Written relative to this file, they resolve correctly under
// `tsx` (where this file is `deck/call/code/cache-store.ts`) and to a path that does not exist under the bundled
// CLI (where it is `host/line.js`, two directories up from which is not the package). The bundle then fell through
// to hashing itself while `tsx` hashed the sources, so the two disagreed about the version and neither could read
// the other's entries -- which is the same defect this function was rewritten to remove, one level along.
const COMPILER_DIRS = ['deck/make/code', 'deck/call/code']

// The package root: the directory whose `package.json` is this package. `compilerVersion` walks for the same thing
// to read the version out of it, so the walk lives here once and both use it.
let cachedRoot: string | null | undefined

function packageRoot(): string | null {
  if (cachedRoot !== undefined) {
    return cachedRoot
  }

  let dir = path.dirname(fileURLToPath(import.meta.url))

  for (;;) {
    const manifest = path.join(dir, 'package.json')

    if (existsSync(manifest)) {
      try {
        const pkg = JSON.parse(readFileSync(manifest, 'utf8')) as {
          name?: string
        }

        // BOTH NAMES, because the package was renamed from `@cluesurf/seed.tree` to `@cluesurf/term`
        if (
          pkg.name === '@cluesurf/term' ||
          pkg.name === '@cluesurf/seed.tree'
        ) {
          cachedRoot = dir

          return cachedRoot
        }
      } catch {
        // keep walking up
      }
    }

    const up = path.dirname(dir)

    if (up === dir) {
      cachedRoot = null

      return cachedRoot
    }

    dir = up
  }
}

// Fingerprint the compiler's own SOURCE, when the source is present.
//
// WHY NOT THE RUNNING FILE. This used to hash `process.argv[1]`, which is right for the bundled CLI (`host/line.js`
// IS the whole compiler) and wrong twice over otherwise. Under `tsx` both candidates end in `.ts`, every one was
// skipped, and the function returned `''` -- the invalidation scheme silently off, so a compiler edit did NOT
// invalidate the cache and a stale hit was possible. And inside a build worker `argv[1]` is the worker's own
// `/tmp/seed-build-worker-<pid>.mjs` bundle, which hashes differently from `host/line.js`, so the parallel build and
// the sequential build wrote to two namespaces and neither could read the other's work.
//
// The source tree answers both: it is the same fingerprint from the CLI, from `tsx`, and from inside a worker.
// Path + size + mtime rather than content, because it runs once per process and a stat is a thousand times cheaper
// than a read. A touched-but-unchanged file costs one needless rebuild, which is the safe direction.
function compilerSourceHash(kind?: string): string {
  const root = packageRoot()

  if (!root) {
    return ''
  }

  const parts: string[] = []

  // A KIND IS FINGERPRINTED AGAINST ONLY THE CODE THAT CAN REACH IT. Walking all 220 compiler files means a change
  // to the Swift emitter opens a new namespace for every kind, every env and every project, and strands the lot.
  // Measured 2026-09-02 after a day of compiler work: `total 143 MB: 396 B live, 143 MB stale`. Every cache in the
  // tree dead, at 78x per file to rebuild (see projectCache below).
  //
  // The file list per kind is GENERATED from the import graph by task/term/cache-scope.ts and held by
  // `pnpm term:cache-scope`, so it cannot drift into a wrong second answer. mill is 14 files, output 61.
  const scoped = kind ? CACHE_SCOPE[kind] : undefined

  if (scoped) {
    for (const file of scoped) {
      const full = path.join(root, file)

      try {
        const stat = lstatSync(full)
        parts.push(`${full}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
      } catch {
        // a listed file that is gone is itself a change, and contributes nothing rather than throwing
      }
    }

    return parts.length > 0 ? hashText(parts.join('\n')) : ''
  }

  const walk = (at: string): void => {
    let names: string[]

    try {
      names = readdirSync(at).sort()
    } catch {
      return
    }

    for (const name of names) {
      const full = path.join(at, name)

      try {
        const stat = lstatSync(full)

        if (stat.isSymbolicLink()) {
          continue
        }

        if (stat.isDirectory()) {
          walk(full)
        } else if (name.endsWith('.ts')) {
          parts.push(`${full}:${stat.size}:${Math.floor(stat.mtimeMs)}`)
        }
      } catch {
        // unreadable entries simply do not contribute
      }
    }
  }

  for (const dir of COMPILER_DIRS) {
    const full = path.join(root, dir)

    if (existsSync(full)) {
      walk(full)
    }
  }

  return parts.length > 0 ? hashText(parts.join('\n')) : ''
}

// Fall back to hashing the running bundle, for an installed package with no sources beside it. `.mjs` as well as
// `.js`: a build worker's entry is a temp `seed-build-worker-<pid>.mjs`, and a `.js`-only test skipped it.
function runningFileHash(): string {
  const candidates = [process.argv[1], fileURLToPath(import.meta.url)]

  for (const file of candidates) {
    try {
      if (
        file &&
        (file.endsWith('.js') || file.endsWith('.mjs')) &&
        existsSync(file)
      ) {
        return hashText(readFileSync(file, 'utf8'))
      }
    } catch {
      // try the next candidate
    }
  }

  return ''
}

function compilerCodeHash(kind?: string): string {
  return compilerSourceHash(kind) || runningFileHash()
}

// the package version, read once
function packageVersion(): string {
  const root = packageRoot()

  if (!root) {
    return '0'
  }

  try {
    const pkg = JSON.parse(
      readFileSync(path.join(root, 'package.json'), 'utf8'),
    ) as { version?: string }

    return pkg.version ?? '0'
  } catch {
    // an unreadable manifest leaves the '0' default, and the code hash still separates compilers
    return '0'
  }
}

// The fingerprint of the running compiler FOR ONE CACHE KIND. Two kinds now have two namespaces, and a change that
// only one of them can see strands only that one. Memoized per kind: it is a stat walk of a few dozen files, and
// it runs on every cache access.
const cachedVersions = new Map<string, string>()

export function compilerVersion(kind?: string): string {
  const at = kind ?? '*'
  const already = cachedVersions.get(at)

  if (already !== undefined) {
    return already
  }

  const version = `${CACHE_EPOCH}:${packageVersion()}:${compilerCodeHash(kind)}`
  cachedVersions.set(at, version)

  return version
}

// every kind's version, for handing to a build worker in one object (see projectCache)
export function compilerVersions(): Record<string, string> {
  const out: Record<string, string> = {}

  for (const kind of Object.keys(CACHE_SCOPE)) {
    out[kind] = compilerVersion(kind)
  }

  return out
}

// the machine-wide shared cache home (Tier 5). Mill entries are content + path addressed, and linked stdlib files
// share a realpath across projects, so the stdlib is milled once for every project on the machine. Overridable for
// tests / CI via TERM_CACHE_HOME (the SEED_ spelling is still honored; see code/home.ts).
export function cacheHome(): string {
  return env('CACHE_HOME') ?? userHome('store')
}

// the project-local cache directory, in one place so the report tool and `term wash` cannot drift from the store.
export function projectCacheDir(projectRoot: string): string {
  return path.join(projectRoot, '.base/@cluesurf/term', 'cache')
}

// a store that routes the per-module `mill` level to a shared dir (reused across projects) and the whole-graph
// `output` level to the project-local dir (a graph is project-specific). The big win is cross-project mill reuse.
export function sharedCacheStore(
  localDir: string,
  sharedDir: string,
  version: string | ((kind: string) => string),
): CacheStore {
  const local = diskCacheStore(localDir, version)
  const shared = diskCacheStore(sharedDir, version)
  const storeFor = (kind: string): CacheStore =>
    kind === 'mill' ? shared : local

  return {
    load: (kind, key) => storeFor(kind).load(kind, key),
    save: (kind, key, value) => storeFor(kind).save(kind, key, value),
  }
}

// a persistent compile cache for a project: per-module mills shared machine-wide, the project's compiled output local.
// Versioned by the compiler, so a toolchain upgrade invalidates everything. The call sites use this.
//
// `version` is passed in by a BUILD WORKER, which cannot work it out for itself. A worker's module is a bundle in
// the system temp directory, so the walk for the package root finds nothing there and the source fingerprint comes
// back empty; the worker would fall back to hashing its own bundle and land in a namespace its parent never reads.
// That is not a small loss. `@term/bind` is 3,091 files that take 165 ms each to compile and 2.1 ms each to serve
// from cache, so a build that cannot read its own cache pays 78x for every file: measured at 508s and then 512s for
// two identical builds, with 3,091 entries sitting on disk the whole time.
//
// The parent passes `compilerVersion()` down (`build-parallel.ts` -> `workerData`), so a build has ONE version by
// construction rather than by two computations agreeing.
//
// `version` is now per KIND. A build worker is handed the whole map (`compilerVersions()`), because it cannot work
// any of them out for itself, and because a parent and a worker that computed them separately could disagree.
export function projectCache(
  projectRoot: string,
  version: Record<string, string> = compilerVersions(),
): CompileCache {
  const forKind = (kind: string): string =>
    version[kind] ?? compilerVersion(kind)

  return new CompileCache(
    sharedCacheStore(projectCacheDir(projectRoot), cacheHome(), forKind),
    // per kind here too: the key folds the version in, so passing one version would put the output fingerprint
    // into every mill key and undo the split the store directory just made
    forKind,
  )
}
