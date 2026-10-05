// Incremental compile cache test: the cache must (1) return byte-identical output to the uncached path, (2) hit the
// output cache on an unchanged re-compile, and (3) reuse a module's mill across a graph where only a sibling changed.
// Run: npx tsx test/compile/cache.ts

import { compile } from '@term/make/code/compile/compile'
import {
  CompileCache,
  hashFields,
} from '@term/make/code/compile/cache'
// the content hash is Term since 2026-10-02 (deck/make/code/term/hash.tree, note/term/self-host/04-the-port-switch.md)
import { hashText } from '@term/make/code/term/hash'
import type { CacheStore } from '@term/make/code/compile/cache'
import {
  diskCacheStore,
  versionSlug,
  enforceBudget,
  cacheEntries,
  KEEP_VERSIONS,
} from '@term/call/code/cache-store'

// every FILE under a directory, used by the layout checks below
function walkFiles(dir: string): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true, recursive: true })
    .filter(e => e.isFile())
    .map(e => nodePath.join(e.parentPath ?? e.path, e.name))
}
import type { Source } from '@term/make/code/compile/load'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as nodePath from 'node:path'

let pass = 0
let fail = 0

function expect(name: string, got: unknown, want: unknown): void {
  if (got === want) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(
      `FAIL  ${name}  (got ${JSON.stringify(
        got,
      )}, want ${JSON.stringify(want)})`,
    )
  }
}

const DOUBLE = `task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2
`

// a tiny module graph: an entry that loads a `helper` module
const helper: Source = {
  file: 'helper.tree',
  text: `task triple\n  take n, like number\n  like number\n  back\n    call multiply\n      read n\n      code 3\n`,
}

function entryText(constant: number): string {
  return `load @app/helper\n  find triple\n\ntask run\n  like number\n  back\n    call triple\n      code ${constant}\n`
}

const resolve = (path: string): Source | undefined =>
  path === '@app/helper' ? helper : undefined

// 1. cached output equals uncached output, exactly
const plain = compile({ file: 'a.tree', text: DOUBLE })
const cache = new CompileCache()
const cached = compile({ file: 'a.tree', text: DOUBLE }, { cache })
expect(
  'cache: uncached and cached compile to the same TypeScript',
  cached.ok && plain.ok && cached.typescript === plain.typescript,
  true,
)

// 2. an unchanged re-compile is an output-cache hit (no extra misses)
const missesBefore = cache.misses
const again = compile({ file: 'a.tree', text: DOUBLE }, { cache })
expect(
  'cache: re-compiling unchanged source adds no misses',
  cache.misses,
  missesBefore,
)
expect(
  'cache: the hit returns the same output object',
  again === cached,
  true,
)

// 3. editing the entry but not the helper reuses the helper's mill (the helper is not re-milled)
const graph = new CompileCache()
const first = compile(
  { file: 'entry.tree', text: entryText(5) },
  { resolve, cache: graph },
)

expect(
  'graph: first compile of the loaded program succeeds',
  first.ok,
  true,
)

const millMissesAfterFirst = graph.misses
const second = compile(
  { file: 'entry.tree', text: entryText(9) },
  { resolve, cache: graph },
)

expect('graph: editing the entry still compiles', second.ok, true)
// the entry changed (new graph key, new entry mill) but the helper text is identical: exactly one new mill miss for
// the entry, one for the entry's import scan (`CompileCache.scanned`), plus one output miss for the new graph key.
// The helper's mill and scan are hits, not misses.
expect(
  'graph: only the changed entry (and the new graph key) miss, the helper is reused',
  graph.misses - millMissesAfterFirst,
  3,
)

// hashText is content-addressed: same text same hash, different text different hash
expect(
  'hash: identical text hashes identically',
  hashText('abc') === hashText('abc'),
  true,
)
expect(
  'hash: different text hashes differently',
  hashText('abc') !== hashText('abd'),
  true,
)

// hashFields is unambiguous: length-prefixing prevents a concatenation collision
expect(
  'hash: hashFields avoids the concatenation collision (a|bc vs ab|c)',
  hashFields(['a', 'bc']) !== hashFields(['ab', 'c']),
  true,
)

// ---- Tier 1: persistence + versioned keys ----

// an in-memory CacheStore standing in for `.seed/cache`, so a second cache simulates a cold process sharing the store
function memStore(): CacheStore {
  const map = new Map<string, string>()

  return {
    load: (kind, key) => map.get(`${kind}/${key}`),
    save: (kind, key, value) => {
      map.set(`${kind}/${key}`, value)
    },
  }
}

// 4. a cold cache sharing the store hits disk instead of rebuilding, and returns identical output
const store = memStore()
const warm = new CompileCache(store, 'v1')
const warmResult = compile(
  { file: 'p.tree', text: DOUBLE },
  { cache: warm },
)

const cold = new CompileCache(store, 'v1')
const coldResult = compile(
  { file: 'p.tree', text: DOUBLE },
  { cache: cold },
)

expect('persist: cold cache rebuilds nothing', cold.misses, 0)
expect('persist: cold cache hits the store', cold.diskHits > 0, true)
expect(
  'persist: cold output equals warm output',
  coldResult.ok &&
    warmResult.ok &&
    coldResult.typescript === warmResult.typescript,
  true,
)

// 5. a different compiler version does NOT reuse the prior entries (no stale hit across a toolchain change)
const upgraded = new CompileCache(store, 'v2')
compile({ file: 'p.tree', text: DOUBLE }, { cache: upgraded })
expect(
  'version: a new compiler version misses the old store entries',
  upgraded.misses > 0,
  true,
)

// 6. an edited source misses (content-addressed, even cold)
const edited = new CompileCache(store, 'v1')
compile({ file: 'p.tree', text: `${DOUBLE}\n` }, { cache: edited })
expect('persist: edited source misses', edited.misses > 0, true)

// 7. the real on-disk store round-trips (atomic writes), giving a cold hit
const dir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-'))
const disk = diskCacheStore(dir, 'v1')
compile(
  { file: 'd.tree', text: DOUBLE },
  { cache: new CompileCache(disk, 'v1') },
)

const diskCold = new CompileCache(disk, 'v1')
compile({ file: 'd.tree', text: DOUBLE }, { cache: diskCold })
expect(
  'disk: a cold cache hits the on-disk entry',
  diskCold.diskHits > 0 && diskCold.misses === 0,
  true,
)
fs.rmSync(dir, { recursive: true, force: true })

// 8. THE LAYOUT AND ITS HOUSEKEEPING (build-cache-size). Every one of these guards a specific way the cache grew to
// 101 GB on a laptop before 2026-09-01, so each is stated as the thing that went wrong.

// entries are gzipped on disk, not stored as the raw JSON they used to be (13.1x on real entries)
const gzDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-gz-'))
const gzStore = diskCacheStore(gzDir, 'v1')
gzStore.save('output', 'aabbcc', JSON.stringify({ padding: 'x'.repeat(20000) }))

// the entries: the namespace's `.budget` stamp (when the byte budget was last held) is housekeeping, not an entry
const written = walkFiles(gzDir).filter(f => nodePath.basename(f) !== '.budget')
expect('layout: the budget stamp sits in the namespace, beside the shards', walkFiles(gzDir).some(f => f.endsWith(nodePath.join(versionSlug('v1'), '.budget'))), true)
expect('layout: an entry is written gzipped', written.every(f => f.endsWith('.json.gz')), true)
expect(
  'layout: gzip actually shrinks the entry',
  written.reduce((n, f) => n + fs.statSync(f).size, 0) < 2000,
  true,
)
expect('layout: a gzipped entry reads back', gzStore.load('output', 'aabbcc') !== undefined, true)

// the version is a DIRECTORY, so a stale namespace is a directory to remove rather than keys nobody can find
expect(
  'layout: the version is a path segment',
  written.every(f => f.includes(nodePath.join('output', versionSlug('v1')))),
  true,
)

// the key is sharded, so no cache is a hundred thousand files in one directory
expect(
  'layout: the key is sharded',
  written.every(f => nodePath.basename(nodePath.dirname(f)) === 'aa'),
  true,
)

// A COMPILER CHANGE STRANDS A NAMESPACE, and the strand is what has to be reclaimed. This is the whole 73 GB:
// `deck/base` held 20,216 output entries for a 532-file package, 38 stranded copies of every file.
for (const version of ['v2', 'v3', 'v4']) {
  diskCacheStore(gzDir, version).save('output', 'aabbcc', '{}')
}

const kept = fs.readdirSync(nodePath.join(gzDir, 'output'))
expect(
  `reclaim: only ${KEEP_VERSIONS} version namespaces survive`,
  kept.length === KEEP_VERSIONS,
  true,
)
expect(
  'reclaim: the newest namespace is one of them',
  kept.includes(versionSlug('v4')),
  true,
)
expect(
  'reclaim: the oldest namespace is gone',
  !kept.includes(versionSlug('v1')),
  true,
)

// A BUDGET BOUNDS WHAT IS LEFT, dropping least-recently-used first. Nothing a cache holds can change a result, so
// the worst case of over-eviction is a slower build.
const budgetDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-budget-'))
const budgetStore = diskCacheStore(budgetDir, 'v1')

for (let n = 0; n < 40; n++) {
  budgetStore.save('output', `k${String(n).padStart(4, '0')}`, JSON.stringify({ n, pad: String(n).repeat(4000) }))
}

const before = walkFiles(budgetDir)
// half of what is actually on disk, measured rather than guessed: the entries are gzipped, and a guessed byte
// budget over compressible padding is met before a single entry has to go, so the check passes without evicting
const budget = Math.floor(
  before.reduce((n, f) => n + fs.statSync(f).size, 0) / 2,
)
const swept = enforceBudget(budgetDir, 'output', versionSlug('v1'), budget)
const after = walkFiles(budgetDir)

expect(
  'budget: over-budget entries are dropped',
  swept.removed > 0 && after.length < before.length,
  true,
)
expect(
  'budget: the sweep stops at the budget',
  after.reduce((n, f) => n + fs.statSync(f).size, 0) <= budget,
  true,
)
expect('budget: the sweep keeps the rest', after.length > 0, true)

// A SWEEP MUST NOT FOLLOW A SYMLINK. Following them made the first cache report claim 1,557,034 files under
// `deck/zone`, which holds 40,725: the 56 symlinks in there point at package trees, and a sweep that deletes by
// that measurement deletes the wrong thing.
const linkDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-link-'))
const outside = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-outside-'))
fs.writeFileSync(nodePath.join(outside, 'big.bin'), 'y'.repeat(50000))
fs.mkdirSync(nodePath.join(linkDir, 'output'), { recursive: true })
fs.symlinkSync(outside, nodePath.join(linkDir, 'output', 'linked'))

const seen = cacheEntries(linkDir)
expect('walk: a symlink is never followed', seen.length === 0, true)
expect('walk: the linked tree is untouched', fs.existsSync(nodePath.join(outside, 'big.bin')), true)

// THE IMPORT SCAN ROUND-TRIPS THROUGH THE DISK. A `find` with no `name` stores an `undefined` alias, which JSON
// writes as `null`; read back plainly, it bound an alias called `null` and the module's imports bound nothing
const scanDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-scan-'))
const scanWarm = new CompileCache(diskCacheStore(scanDir, 'v1'), 'v1')
const scanFirst = compile({ file: 'a.tree', text: entryText(4) }, { resolve, cache: scanWarm })
const scanCold = new CompileCache(diskCacheStore(scanDir, 'v1'), 'v1')
// another entry text, so the output level misses and the scans are what the walk reads from the disk
const scanSecond = compile({ file: 'a.tree', text: entryText(5) }, { resolve, cache: scanCold })
expect('scan: the first compile builds', scanFirst.ok, true)
expect('scan: a fresh process reads the helper scan from disk', scanCold.diskHits > 0, true)
expect('scan: and its imports still bind (`triple` is found)', scanSecond.ok, true)

// THE TEMPLATE SET JOINS ONLY THE KEY OF A UNIT WITH A `fuse`. An edit to a template-bearing module re-mills only the
// units that can use it, not the whole closure
const shapes: Source = { file: 'shapes.tree', text: `tree twice\n  take name\n  hook fuse\n    task {name}-twice\n      take n, like number\n      like number\n      back multiply(n, 2)\n` }
const templateResolve = (path: string): Source | undefined =>
  path === '@app/helper' ? helper : path === '@app/shapes' ? shapes : undefined
const withTemplates = `load @app/helper\n  find triple\n\nload @app/shapes\n\ntask run\n  like number\n  back\n    call triple\n      code 1\n`
const templateCache = new CompileCache()
compile({ file: 'a.tree', text: withTemplates }, { resolve: templateResolve, cache: templateCache })
const builtBefore = templateCache.misses
shapes.text = `${shapes.text}# edited\n`
compile({ file: 'a.tree', text: withTemplates }, { resolve: templateResolve, cache: templateCache })
// the edit re-mills shapes.tree itself and its scan, and builds the output: three, never the helper or the entry
expect('templates: editing a template module leaves units with no `fuse` cached', templateCache.misses - builtBefore, 3)

// THE BUDGET IS HELD ONCE AN HOUR. The stamp in the namespace says when it last ran
const stampDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), 'seed-cache-stamp-'))
const { budgetDue } = await import('@term/call/code/cache-store')
expect('budget stamp: the first sweep is due', budgetDue(stampDir, 'mill', 'slug'), true)
expect('budget stamp: one just after it is not', budgetDue(stampDir, 'mill', 'slug'), false)
expect('budget stamp: an hour later it is again', budgetDue(stampDir, 'mill', 'slug', Date.now() + 60 * 60 * 1000 + 1), true)

for (const temp of [gzDir, budgetDir, linkDir, outside, scanDir, stampDir]) {
  fs.rmSync(temp, { recursive: true, force: true })
}

console.log(`\ncache: ${pass} pass, ${fail} fail`)

if (fail > 0) {process.exit(1)}
