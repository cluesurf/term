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
import { cpSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runDir } from './run-dir'

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

// a throwaway copy of the stdlib, with its own empty caches, removed when the run ends (run-dir.ts). It was made with
// `mkdtempSync` and never removed: 1.7 GB a run once both builds wrote their caches, and about 150 runs had left about
// 250 GB in the system temp by 2026-10-05
function freshProject(): { project: string; cacheHome: string } {
  const project = runDir('term-buildtime-')

  cpSync(join(SEED, 'code'), join(project, 'code'), { recursive: true })
  writeFileSync(join(project, 'deck.tree'), 'deck @term/base\n  code <0.0.0>\n')

  return { project, cacheHome: join(project, 'store') }
}

// THE COMPILER MUST HOLD STILL BETWEEN THE TWO BUILDS. The cache's version is a fingerprint of the compiler's source
// files on disk, path, size and mtime (`compilerSourceHash` in deck/call/code/cache-store.ts), read by the bundled CLI
// too. So an edit to any of them between the cold build and the warm one opens a fresh namespace, and the warm build
// is cold BY DESIGN: the safe direction, an edit costing a rebuild and never a stale hit. In a repository where several
// sessions edit the compiler at once, that read as this suite failing, `cold 36.73s, warm 37.63s` (2026-10-05), a
// cache that works blamed for one that was correctly invalidated. What invalidates the cache is `term:cache-hit`'s to
// prove; this suite proves only that an unchanged compiler's warm build reuses what the cold one wrote. So the same
// inputs the version reads are taken before the cold build and after the warm one, and an attempt they differ across
// is retried on a fresh copy; if the compiler moved during every attempt, the suite says so and skips
const COMPILER_DIRS = ['deck/make/code', 'deck/call/code']

function compilerFingerprint(): string {
  const parts: string[] = []

  for (const dir of COMPILER_DIRS) {
    for (const file of (readdirSync(join(TERM, dir), { recursive: true }) as string[]).sort()) {
      if (!file.endsWith('.ts')) continue

      const at = statSync(join(TERM, dir, file))
      parts.push(`${dir}/${file}:${at.size}:${at.mtimeMs}`)
    }
  }

  return parts.join('\n')
}

const ATTEMPTS = 3
let measured: { cold: number; warm: number } | undefined

for (let attempt = 1; attempt <= ATTEMPTS && !measured; attempt++) {
  const { project, cacheHome } = freshProject()
  const before = compilerFingerprint()
  const cold = build(project, cacheHome)
  const warm = build(project, cacheHome)

  if (compilerFingerprint() === before) {
    measured = { cold, warm }
  } else {
    console.log(`  attempt ${attempt}: the compiler's source changed between the builds (cold ${cold.toFixed(2)}s, warm ${warm.toFixed(2)}s), so the warm build was cold by design`)
  }
}

if (!measured) {
  console.log(`skip  the compiler's source changed during each of ${ATTEMPTS} attempts, so no warm build could be measured`)
  process.exit(0)
}

let pass = 0
let fail = 0

const { cold, warm } = measured
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
