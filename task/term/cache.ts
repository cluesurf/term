// The cache report. What every Term cache on this machine holds, whether it is live or stranded, and whether it is
// over budget.
//
// WHY THIS EXISTS. On 2026-09-01 there was 101 GB of Term build cache on one laptop, 86 GB of it under `deck/bind`
// in 143,604 files in a single directory, and every gate was green the whole time because no gate asked. About 36 GB
// a day of it, from ordinary work. `deck/base` held 20,216 output entries for a 532-file package, which is 38
// stranded copies of every file: the cache key carries a hash of the compiler, so every rebuild of the compiler
// opened a fresh namespace and stranded every entry in the previous one, and nothing ever reclaimed them.
//
// So this reports THREE numbers per cache, not one, because the total on its own does not say whether anything is
// wrong:
//
//   live      the current compiler's namespace. This is the cache doing its job
//   stale     namespaces from compilers that are no longer running. Reclaimable, always
//   legacy    the pre-rename `.base/term/cache` path, which nothing has read since 2026-08-30, plus any
//             `cache.*` copy set aside beside a live one
//
// LEGACY IS THE CACHE DIRECTORIES AND NOTHING ELSE. `.base/term/` also holds `boot/` markers, which are state and
// not rebuildable, so `legacyCacheDirs` names `cache` and `cache.*` by hand rather than taking the parent. The first
// draft of this took the parent, and it would have swept 12 MB of `deck/zone`'s boot markers into a cache clean.
//
// Run from the repository root: `pnpm term:cache`. REPORTS BY DEFAULT AND REMOVES NOTHING. `--commit` reclaims the
// stale and legacy directories, which is the same thing the compiler now does for itself on startup
// (`reclaimStaleVersions` in deck/call/code/cache-store.ts); this is the way to do it without waiting for a build.
//
// Design: note/project/term/archive/build-cache-size.md.

import { readdirSync, lstatSync, existsSync, rmSync } from 'node:fs'
import { join, relative, basename } from 'node:path'
import {
  cacheEntries,
  cacheHome,
  compilerVersion,
  versionSlug,
  budgetFor,
  legacyCacheDirs,
  asideCacheDirs,
  KEEP_VERSIONS,
} from '@term/call/code/cache-store'
import { legacyUserHome } from '@term/call/code/home'
import { CACHE_SCOPE } from '@term/make/code/compile/cache-scope.generated'
import { TERM_ROOT } from './root'

// run from the Term root, the way every other term task is (the `@term/*` path aliases resolve there)
const TERM = TERM_ROOT
const DECK = join(TERM, 'deck')

const commit = process.argv.includes('--commit')
const verbose = process.argv.includes('--verbose')

type Slice = {
  label: string
  dir: string
  bytes: number
  files: number
  stale: boolean
}

function sizeOf(dir: string): { bytes: number; files: number } {
  const entries = cacheEntries(dir)

  return {
    bytes: entries.reduce((n, e) => n + e.size, 0),
    files: entries.length,
  }
}

function human(bytes: number): string {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let at = 0

  while (n >= 1024 && at < units.length - 1) {
    n /= 1024
    at++
  }

  return `${n.toFixed(n >= 100 || at === 0 ? 0 : 1)} ${units[at]}`
}

// One cache root, split into the current compiler's namespace and every stranded one.
// `live` is a function of the KIND, not one string. Each cache kind has its own compiler fingerprint now (mill is
// scoped to 14 files, output to 61, rather than all 220), so the two live in different namespaces and a report
// that knew only one of them called the other stale. A second reader of a layout disagrees with the layout
// eventually, which is the same lesson the store's own header records.
function sliceCache(
  root: string,
  label: string,
  live: (kind: string) => string,
): Slice[] {
  const slices: Slice[] = []

  if (!existsSync(root)) {
    return slices
  }

  let kinds: string[]

  try {
    kinds = readdirSync(root)
  } catch {
    return slices
  }

  for (const kind of kinds.sort()) {
    const kindDir = join(root, kind)

    let names: string[]

    try {
      if (!lstatSync(kindDir).isDirectory()) {
        continue
      }

      names = readdirSync(kindDir)
    } catch {
      continue
    }

    // a FILE directly under the kind is the pre-2026-09-01 flat layout: unreadable now, so it is stale by definition
    const flat = names.filter(n => {
      try {
        return !lstatSync(join(kindDir, n)).isDirectory()
      } catch {
        return false
      }
    })

    if (flat.length > 0) {
      const bytes = flat.reduce((n, name) => {
        try {
          return n + lstatSync(join(kindDir, name)).size
        } catch {
          return n
        }
      }, 0)

      slices.push({
        label: `${label} ${kind} (flat, pre-2026-09-01 layout)`,
        dir: kindDir,
        bytes,
        files: flat.length,
        stale: true,
      })
    }

    for (const name of names.sort()) {
      const dir = join(kindDir, name)

      try {
        if (!lstatSync(dir).isDirectory()) {
          continue
        }
      } catch {
        continue
      }

      const { bytes, files } = sizeOf(dir)

      slices.push({
        label: `${label} ${kind}`,
        dir,
        bytes,
        files,
        stale: name !== live(kind),
      })
    }
  }

  return slices
}

function projectRoots(): { name: string; root: string }[] {
  try {
    return readdirSync(DECK, { withFileTypes: true })
      .filter(e => e.isDirectory())
      .map(e => ({ name: e.name, root: join(DECK, e.name) }))
      .filter(p => existsSync(join(p.root, '.base')))
      .sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

function main(): void {
  const liveOf = (kind: string): string =>
    versionSlug(compilerVersion(kind))
  const named = Object.keys(CACHE_SCOPE)
    .sort()
    .map(kind => `${kind} ${liveOf(kind)}`)
    .join(', ')

  console.log(
    `term cache: live namespaces ${named}, keeping ${KEEP_VERSIONS} of each`,
  )
  console.log('')

  const rows: {
    where: string
    live: number
    stale: number
    legacy: number
    files: number
    over: string
  }[] = []
  const doomed: Slice[] = []

  const measure = (where: string, root: string, retired: string[] = []): void => {
    const slices = sliceCache(root, where, liveOf)
    const legacySlices = retired
      .filter(dir => existsSync(dir))
      .map(dir => {
        const { bytes, files } = sizeOf(dir)

        return {
          label: `${where} ${basename(dir)} (retired)`,
          dir,
          bytes,
          files,
          stale: true,
        }
      })

    if (slices.length === 0 && legacySlices.length === 0) {
      return
    }

    const liveBytes = slices
      .filter(s => !s.stale)
      .reduce((n, s) => n + s.bytes, 0)
    const staleBytes = slices
      .filter(s => s.stale)
      .reduce((n, s) => n + s.bytes, 0)
    const legacyBytes = legacySlices.reduce((n, s) => n + s.bytes, 0)
    const files =
      slices.reduce((n, s) => n + s.files, 0) +
      legacySlices.reduce((n, s) => n + s.files, 0)

    doomed.push(...slices.filter(s => s.stale), ...legacySlices)

    // over budget is asked of the LIVE namespace only: a stale one is going away, so its size is not a design fault
    const over = slices
      .filter(s => !s.stale)
      .filter(s => {
        const kind = s.label.split(' ').pop() ?? ''

        return s.bytes > budgetFor(kind)
      })
      .map(s => s.label)
      .join(', ')

    rows.push({
      where,
      live: liveBytes,
      stale: staleBytes,
      legacy: legacyBytes,
      files,
      over,
    })

    if (verbose) {
      for (const slice of [...slices, ...legacySlices]) {
        console.log(
          `    ${slice.stale ? 'stale' : 'live '}  ${human(slice.bytes).padStart(8)}  ${String(slice.files).padStart(7)} files  ${relative(TERM, slice.dir)}`,
        )
      }
    }
  }

  for (const project of projectRoots()) {
    measure(project.name, join(project.root, '.base/@term/code/cache'), [
      ...legacyCacheDirs(project.root),
      ...asideCacheDirs(project.root),
    ])
  }

  // The user-level store has a legacy twin from the same 2026-08-30 rename, and it was the largest single thing
  // left after the project caches were reclaimed: 3.3 GB in `~/.base/term/store`.
  //
  // ONLY `store`. `~/.base/term/` also holds `key` and `auth`, the signing key and the auth token, which are
  // exactly the things `keptAt` exists to protect: they cannot be rebuilt, and the rename deliberately reads the old
  // location when the new one is absent. Naming `store` by hand is what keeps a cache clean from taking them.
  measure('(shared user store)', cacheHome(), [legacyUserHome('store')])

  const width = Math.max(12, ...rows.map(r => r.where.length))
  console.log(
    `  ${'where'.padEnd(width)}  ${'live'.padStart(9)}  ${'stale'.padStart(9)}  ${'legacy'.padStart(9)}  ${'files'.padStart(8)}`,
  )

  for (const row of rows.sort(
    (a, b) => b.live + b.stale + b.legacy - (a.live + a.stale + a.legacy),
  )) {
    console.log(
      `  ${row.where.padEnd(width)}  ${human(row.live).padStart(9)}  ${human(row.stale).padStart(9)}  ${human(row.legacy).padStart(9)}  ${String(row.files).padStart(8)}${row.over ? `   OVER BUDGET: ${row.over}` : ''}`,
    )
  }

  const liveTotal = rows.reduce((n, r) => n + r.live, 0)
  const staleTotal = rows.reduce((n, r) => n + r.stale, 0)
  const legacyTotal = rows.reduce((n, r) => n + r.legacy, 0)
  const overBudget = rows.filter(r => r.over)

  console.log('')
  console.log(
    `  total ${human(liveTotal + staleTotal + legacyTotal)}: ${human(liveTotal)} live, ${human(staleTotal)} stale, ${human(legacyTotal)} legacy`,
  )

  const reclaimable = staleTotal + legacyTotal

  if (reclaimable > 0 && !commit) {
    console.log('')
    console.log(
      `  ${human(reclaimable)} is reclaimable across ${doomed.length} director${doomed.length === 1 ? 'y' : 'ies'}. Re-run with --commit to reclaim it,`,
    )
    console.log(
      '  or let it go on its own: the compiler reclaims a stale namespace on its next build of that project.',
    )
  }

  if (commit && doomed.length > 0) {
    let freed = 0

    for (const slice of doomed) {
      try {
        rmSync(slice.dir, { recursive: true, force: true })
        freed += slice.bytes
      } catch {
        console.log(`  could not reclaim ${relative(TERM, slice.dir)}`)
      }
    }

    console.log('')
    console.log(`  reclaimed ${human(freed)}`)
  }

  // the GATE: a live namespace over its budget is the only failure. Stale and legacy are reclaimable by definition
  // and must not fail a board that is otherwise green, or the failure becomes noise nobody reads.
  if (overBudget.length > 0) {
    console.log('')

    for (const row of overBudget) {
      console.log(`  OVER BUDGET  ${row.where}: ${row.over}`)
    }

    process.exitCode = 1
  }

  console.log('')
  console.log(
    `term cache: ${rows.length} cache${rows.length === 1 ? '' : 's'}, ${overBudget.length} over budget`,
  )
}

main()
