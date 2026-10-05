// Does the build cache still work? Cold and warm `term make` on the stdlib closure.
//
// WHY A RATIO AND NOT A CLOCK. Wall-clock seconds are a property of the machine, so an absolute threshold either
// passes everywhere (useless) or fails on a slow laptop (noise). What a regression actually breaks is the CACHE: a
// key that stops matching, an entry that stops being written, a bound that evicts what the next file needed. That
// shows up as warm approaching cold, which is machine-independent.
//
// The numbers on the machine this was written on (2026-08-30, a copy of the stdlib, 513 files):
//
//   cold  10.76s   no mill cache, no output cache
//   warm   7.27s
//   cold/warm 1.48x
//
// It builds a COPY of the stdlib in a temporary directory rather than `deck/base` itself, and points
// TERM_CACHE_HOME at a fresh dir, so both cache levels start genuinely empty. Measuring in place would mean moving
// the real project's cache aside, and `pnpm term:test` runs suites CONCURRENTLY: another suite building the stdlib
// at that moment would see the cache vanish under it. Nothing the user owns is touched.
//
// Run: npx tsx test/compile/build-time.ts

import { execFileSync } from 'node:child_process'
import { cpSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')
const SEED = join(TERM, 'deck/base')

// warm must be at least this much faster than cold. The measured ratio was 1.48x; 1.20 is clear of noise, and a
// cache that stopped working entirely would sit at 1.0.
const LEAST = 1.2

function build(project: string, cacheHome: string): number {
  const started = Date.now()

  execFileSync('node', [LINE, 'make'], {
    cwd: project,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    // the copy IS the stdlib for this build. Without TERM_STDLIB its `@term/base/...` loads reached the real one at
    // deck/base, so `atomic.tree`, `file/handle.tree` and the rest came in twice under two paths, and binding forms by
    // file made each a second type: `expected atomic__in0_0, found atomic`, 59 errors (2026-10-04)
    // and by its real path: the temporary folder is `/var/...`, a link to `/private/var/...` on macOS, and the build
    // walks the real one, so the link would bring every module in twice again
    env: { ...process.env, TERM_CACHE_HOME: cacheHome, TERM_STDLIB: realpathSync(project) },
    maxBuffer: 64 * 1024 * 1024,
  })

  return (Date.now() - started) / 1000
}

// a throwaway copy of the stdlib, with its own empty caches
const project = mkdtempSync(join(tmpdir(), 'term-buildtime-'))
const cacheHome = join(project, 'store')

cpSync(join(SEED, 'code'), join(project, 'code'), { recursive: true })
writeFileSync(join(project, 'deck.tree'), 'deck @term/base\n  code <0.0.0>\n')

let pass = 0
let fail = 0

const cold = build(project, cacheHome)
const warm = build(project, cacheHome)
const ratio = cold / Math.max(warm, 0.001)

console.log(
  `  cold ${cold.toFixed(2)}s, warm ${warm.toFixed(2)}s, ratio ${ratio.toFixed(2)}x (at least ${LEAST})`,
)

if (ratio >= LEAST) {
  pass++
} else {
  fail++
  console.log(
    '  A warm build is no faster than a cold one, so the build cache is not being reused.\n' +
      '  Look at CompileCache in deck/make/code/compile/cache.ts and its store in deck/call/code/cache-store.ts.',
  )
}

console.log(`\nbuild-time: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
