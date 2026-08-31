// Does a project build hold memory FLAT as the file count grows?
//
// WHY THIS EXISTS. `@term/bind` (3,091 .tree files) exhausted an 8 GB heap and died with "Ineffective mark-compacts
// near heap limit". The cause was not the compiler's working set: it was `CompileCache.outputs`, an unbounded Map
// holding one full compile result per ENTRY FILE, at roughly 370 KB each. Measured on bind at 400 files, retained
// heap after a forced GC:
//
//   both caches   172 MB          outputs cleared    29 MB
//   mills cleared 178 MB          neither            23 MB
//
// So the output cache WAS the retained heap, and it is the only structure that scaled with the project rather than
// with the module graph. Its hit rate in a project build is zero by construction (each entry is visited once and has
// its own graph key), so it was paying nothing for it. Both caches are LRU-bounded now.
//
// The bug is invisible to every other check: the compiler is correct either way, and a build that OOMs at 3,000
// files passes every suite at 300. What has to be asserted is the SHAPE of the curve, so this measures retained heap
// at a low and a high file count and fails if the second is more than a small multiple of the first.
//
// Run: pnpm term:build-memory            (report; non-zero if memory grows with the file count)
//      pnpm term:build-memory --verbose  (every sample)
//
// It lives here rather than in task/ because it imports the compiler directly, and the `@term/*` aliases only
// resolve inside this package.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import { withNativeEnv } from '@term/make/code/compile/native'
import { projectResolver, findTreeFiles } from '@term/call/code/make'
import { projectDeckOf } from '@term/call/code/deck-of'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname

// the largest package in the tree, which is the only one big enough for the curve to show
const PACKAGE = join(HERE, '../../deck/bind')

// how many files to compile at the low and high sample. The high one has to be several times the low, or a linear
// leak and a flat curve look the same.
const LOW = 200
const HIGH = 1200

// retained heap at HIGH may be at most this multiple of retained heap at LOW. A leak of one full compile result per
// file put the real ratio near 6x at these counts; a flat curve sits near 1x. Three is well clear of both.
const LIMIT = 3

const gc = () => {
  const collect = (globalThis as { gc?: () => void }).gc

  if (!collect) {
    console.log('run with --expose-gc (pnpm term:build-memory does)')
    process.exit(1)
  }

  collect()
  collect()
}

const heapMb = () => {
  gc()

  return Math.round(process.memoryUsage().heapUsed / 1048576)
}

const verbose = process.argv.includes('--verbose')
const files = findTreeFiles(PACKAGE, [], 'node')

if (files.length < HIGH) {
  console.log(`${PACKAGE} has ${files.length} .tree files, fewer than the ${HIGH} this needs`)
  process.exit(1)
}

const cache = new CompileCache()
const resolve = withNativeEnv('node', projectResolver(PACKAGE))
const deckOf = projectDeckOf()

let low = 0
let high = 0

for (const [index, file] of files.slice(0, HIGH).entries()) {
  compile({ file, text: readFileSync(file, 'utf8') }, { resolve, cache, deckOf })

  const done = index + 1

  if (done === LOW) {
    low = heapMb()
  }

  if (done === HIGH) {
    high = heapMb()
  }

  if (verbose && done % 200 === 0) {
    console.log(`  ${String(done).padStart(5)} files  ${heapMb()} MB`)
  }
}

const ratio = low > 0 ? high / low : Infinity

const flat = ratio <= LIMIT

console.log(
  `  ${low} MB at ${LOW} files, ${high} MB at ${HIGH}, ratio ${ratio.toFixed(2)} (limit ${LIMIT})`,
)

if (!flat) {
  console.log(
    '  Memory grows with the FILE count, so something is retained per entry rather than per module.\n' +
      '  The usual cause is a cache that is not bounded. See deck/make/code/compile/cache.ts.',
  )
}

console.log(`\nbuild-memory: ${flat ? 1 : 0} pass, ${flat ? 0 : 1} fail`)

if (!flat) {
  process.exit(1)
}
