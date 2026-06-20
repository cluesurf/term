// Incremental / hot-reload test: the IncrementalCompiler keeps the compiled mesh warm so an unchanged recompile is an
// instant cache hit, and editing one module only re-mills that module (its importers reuse their parse + mill). This
// is the engine behind `make --ride` watch mode and the LSP. Run: npx tsx test/compile/watch.ts

import { IncrementalCompiler } from '@/code/compile/watch'
import type { Source } from '@/code/compile/load'

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
    'task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 3\n',
  ],
])
const resolve = (path: string): Source | undefined =>
  files.has(path) ? { file: path, text: files.get(path)! } : undefined
const entry = (constant: number): Source => ({
  file: 'entry.tree',
  text: `load @app/helper\n  find triple\n\ntask run\n  like number\n  send back\n    call triple\n      mark ${constant}\n`,
})

const compiler = new IncrementalCompiler(resolve)

// 1. first compile builds everything
const first = compiler.compile(entry(5))
expect('first compile succeeds', first.ok, true)

// 2. recompiling the identical graph is an instant output-cache hit: no new misses
const missesAfterFirst = compiler.stats.misses
const again = compiler.compile(entry(5))
expect(
  'unchanged recompile adds no misses',
  compiler.stats.misses,
  missesAfterFirst,
)
expect('unchanged recompile is a hit', again === first, true)

// 3. edit the entry but not the helper: the helper's parse+mill is reused (a hit), only the entry + new graph miss
const hitsBeforeEdit = compiler.stats.hits
const missesBeforeEdit = compiler.stats.misses
const edited = compiler.compile(entry(9))
expect('editing the entry still compiles', edited.ok, true)
expect(
  'the unchanged helper is reused (a mill hit)',
  compiler.stats.hits > hitsBeforeEdit,
  true,
)
expect(
  'only the entry + the new graph key miss',
  compiler.stats.misses - missesBeforeEdit,
  2,
)

// 4. edit the helper itself: now the helper re-mills (a miss), the entry text is unchanged so it is reused
files.set(
  '@app/helper',
  'task triple\n  take n, like number\n  like number\n  send back\n    call multiply\n      read n\n      mark 4\n',
)
const hitsBeforeHelper = compiler.stats.hits
const afterHelper = compiler.compile(entry(9))
expect('editing the helper still compiles', afterHelper.ok, true)
expect(
  'the unchanged entry is reused after a helper edit',
  compiler.stats.hits > hitsBeforeHelper,
  true,
)

console.log(`\nwatch: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
