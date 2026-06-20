// Incremental compile cache test: the cache must (1) return byte-identical output to the uncached path, (2) hit the
// output cache on an unchanged re-compile, and (3) reuse a module's mill across a graph where only a sibling changed.
// Run: npx tsx test/compile/cache.ts

import { compile } from '@/code/compile/compile'
import {
  CompileCache,
  hashText,
  hashFields,
} from '@/code/compile/cache'
import type { CacheStore } from '@/code/compile/cache'
import { diskCacheStore } from '@/code/call/cache-store'
import type { Source } from '@/code/compile/load'
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
      mark 2
`

// a tiny module graph: an entry that loads a `helper` module
const helper: Source = {
  file: 'helper.tree',
  text: `task triple\n  take n, like number\n  like number\n  back\n    call multiply\n      read n\n      mark 3\n`,
}
function entryText(constant: number): string {
  return `load @app/helper\n  find triple\n\ntask run\n  like number\n  back\n    call triple\n      mark ${constant}\n`
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
// the entry, plus one output miss for the new graph key. The helper mill is a hit, not a miss.
expect(
  'graph: only the changed entry (and the new graph key) miss, the helper is reused',
  graph.misses - millMissesAfterFirst,
  2,
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
const warmResult = compile({ file: 'p.tree', text: DOUBLE }, { cache: warm })
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
const disk = diskCacheStore(dir)
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

console.log(`\ncache: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
