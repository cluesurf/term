// DOES THE CACHE ACTUALLY HIT? Nothing asked, for months, and the answer was no.
//
// `pnpm term:cache` asks how BIG the cache is, which is how 101 GB was found. It cannot ask whether the cache is
// worth having, and the two questions have opposite answers: the same day the size was measured, a warm build of
// `@term/bind` took 423 s against a cold 411 s. Warm was SLOWER. A hundred gigabytes bought nothing, and every
// gate was green the whole time.
//
// This is the other gate. It compiles a small project twice and asserts the second build reads what the first
// wrote, then asserts the per-kind version scoping actually isolates: a compiler change that only the OUTPUT kind
// can see must not strand the mill cache.
//
// IT COUNTS HITS, NOT SECONDS. A timing assertion on a laptop that is also running three toolchains is a flaky
// test, and flaky gates get deleted. Hit counts are deterministic under any load.
//
//   pnpm term:cache-hit

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CompileCache } from '@term/make/code/compile/cache'
import { compile } from '@term/make/code/compile/compile'
import {
  compilerVersions,
  sharedCacheStore,
} from '@term/call/code/cache-store'
import { CACHE_SCOPE } from '@term/make/code/compile/cache-scope.generated'

let ran = 0
let failed = 0

function check(what: string, ok: boolean, detail = ''): void {
  ran += 1

  if (!ok) {
    failed += 1
  }

  console.log(`${ok ? 'ok  ' : 'FAIL'}  ${what}${detail ? `  ${detail}` : ''}`)
}

function same(what: string, got: unknown, want: unknown): void {
  const ok = got === want
  check(what, ok, ok ? '' : `(got ${String(got)}, want ${String(want)})`)
}

// a small self-contained program: enough modules that a hit is unambiguous, small enough to compile in a moment
const SOURCE = `
task double
  take n, like number
  like number
  send back
    call multiply
      read n
      code 2

task quadruple
  take n, like number
  like number
  send back
    call double
      call double
        read n
`

function main(): void {
  const work = mkdtempSync(join(tmpdir(), 'term-cache-hit-'))
  const local = join(work, 'local')
  const shared = join(work, 'shared')
  mkdirSync(local, { recursive: true })
  mkdirSync(shared, { recursive: true })

  const file = join(work, 'main.tree')
  writeFileSync(file, SOURCE)
  const source = { file, text: SOURCE }

  const versions = compilerVersions()
  const build = (
    forKind: (kind: string) => string,
  ): { cache: CompileCache; ok: boolean } => {
    // a NEW CompileCache each time, so the in-memory maps are cold and only the DISK store can answer
    const cache = new CompileCache(
      sharedCacheStore(local, shared, forKind),
      forKind,
    )
    const result = compile(source, { cache })

    return { cache, ok: result.ok }
  }

  const live = (kind: string): string => versions[kind] ?? ''

  // 1. cold: nothing on disk, so everything is a miss and everything is written
  const cold = build(live)
  check('the program compiles', cold.ok)
  check('a cold build misses', cold.cache.misses > 0, `${cold.cache.misses} misses`)
  same('a cold build hits nothing', (cold.cache.hits + cold.cache.diskHits), 0)

  // 2. warm: the same compiler, the same source. The disk store must answer.
  const warm = build(live)
  check('a warm build hits', (warm.cache.hits + warm.cache.diskHits) > 0, `${(warm.cache.hits + warm.cache.diskHits)} hits`)
  same('a warm build misses nothing', warm.cache.misses, 0)

  // 3. THE ONE THIS PROJECT EXISTS FOR. A compiler change the OUTPUT kind can see and the MILL kind cannot must
  // strand only output. Before per-kind scoping every kind shared one fingerprint, so a change to the Swift
  // emitter -- which no cached entry can reach -- cold-started every cache in the tree.
  const outputMoved = (kind: string): string =>
    kind === 'output' ? `${live(kind)}:moved` : live(kind)
  const partial = build(outputMoved)

  check(
    'an output-only compiler change still hits the mill cache',
    (partial.cache.hits + partial.cache.diskHits) > 0,
    `${(partial.cache.hits + partial.cache.diskHits)} hits, ${partial.cache.misses} misses`,
  )

  // 4. A REAL mill change moves BOTH fingerprints, and everything goes cold.
  //
  // Moving mill alone is not a case that can happen, and asserting it was the first thing this gate got wrong:
  // mill's files are a SUBSET of output's, so anything mill can see, output can see too. That subset is the
  // safety property, and it is checked directly below rather than inferred from a build.
  // a DIFFERENT suffix from the output-only move above, or this reuses that namespace and finds its entry
  const bothMoved = (kind: string): string => `${live(kind)}:mill-changed`
  const cold2 = build(bothMoved)

  same(
    'a mill compiler change strands everything',
    cold2.cache.hits + cold2.cache.diskHits,
    0,
  )

  // 5. THE SAFETY PROPERTY, checked on the scope itself rather than through a build.
  //
  // Every file the mill level can reach must also be in the output level's set. If one were not, a change to it
  // would move the mill fingerprint and leave output's alone, and the output cache would serve an entry built by
  // a compiler that no longer exists. That is a stale hit, which is the one failure mode worse than a slow build.
  const millFiles = CACHE_SCOPE['mill'] ?? []
  const outputFiles = new Set(CACHE_SCOPE['output'] ?? [])
  const escaped = millFiles.filter(file => !outputFiles.has(file))

  check(
    'every mill-scope file is also in the output scope',
    escaped.length === 0,
    escaped.length === 0
      ? `${millFiles.length} mill files inside ${outputFiles.size} output files`
      : `outside output: ${escaped.join(', ')}`,
  )

  rmSync(work, { recursive: true, force: true })

  console.log(`\nterm cache-hit: ${ran} checks, ${failed} failed`)

  if (failed > 0) {
    process.exitCode = 1
  }
}

main()
