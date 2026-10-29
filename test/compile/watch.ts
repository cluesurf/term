// Incremental test: one CompileCache held across compiles keeps the compiled mesh warm, so an unchanged recompile is an
// instant cache hit, and editing one module only re-mills that module (its importers reuse their parse + mill). This
// is the engine behind `make --ride` watch mode and the LSP. compile/watch.ts's IncrementalCompiler, a class over this
// same cache, retired (decision 065 of change 001-finish-self-host), so the test holds the cache itself.
// Run: npx tsx test/compile/watch.ts

import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Source } from '@term/make/code/compile/load'

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

// a mutable in-memory project: an entry that loads a `helper` module. Editing the map simulates a file change.
const files = new Map<string, string>([
  [
    '@app/helper',
    'task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 3\n',
  ],
])

const resolve = (path: string): Source | undefined =>
  files.has(path) ? { file: path, text: files.get(path)! } : undefined

const entry = (constant: number): Source => ({
  file: 'entry.tree',
  text: `load @app/helper\n  find triple\n\ntask run\n  like number\n  send back\n    call triple\n      code ${constant}\n`,
})

const cache = new CompileCache()
const build = (source: Source) => compile(source, { resolve, cache })

// 1. first compile builds everything
const first = build(entry(5))
expect('first compile succeeds', first.ok, true)

// 2. recompiling the identical graph is an instant output-cache hit: no new misses
const missesAfterFirst = cache.misses
const again = build(entry(5))
expect(
  'unchanged recompile adds no misses',
  cache.misses,
  missesAfterFirst,
)
expect('unchanged recompile is a hit', again === first, true)

// 3. edit the entry but not the helper: the helper's scan, parse and mill are reused (hits), and only the entry's
// import scan, the entry's mill and the new graph key miss. The scan has had its own entry since the import scan was
// cached per (file, text) (CompileCache.scanned), which is the third
const hitsBeforeEdit = cache.hits
const missesBeforeEdit = cache.misses
const edited = build(entry(9))
expect('editing the entry still compiles', edited.ok, true)
expect(
  'the unchanged helper is reused (a mill hit)',
  cache.hits > hitsBeforeEdit,
  true,
)
expect(
  'only the entry (its scan and its mill) and the new graph key miss',
  cache.misses - missesBeforeEdit,
  3,
)

// 4. edit the helper itself: now the helper re-mills (a miss), the entry text is unchanged so it is reused
files.set(
  '@app/helper',
  'task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      code 4\n',
)

const hitsBeforeHelper = cache.hits
const afterHelper = build(entry(9))
expect('editing the helper still compiles', afterHelper.ok, true)
expect(
  'the unchanged entry is reused after a helper edit',
  cache.hits > hitsBeforeHelper,
  true,
)

console.log(`\nwatch: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
