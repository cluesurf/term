/**
 * The obligation cache + incremental verification. Run from the seed
 * install root:
 *   npx tsx deck/test/code/demo-hold-cache.ts
 *
 * Shows the three behaviors that make verification scale to a whole
 * project: a cold run checks everything, a warm run skips unchanged
 * files (cache hit), and any change to a file - or to a module it loads,
 * or to the toolchain version - invalidates the entry so it re-checks.
 */

import { writeFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { projectResolver } from '@term/call/code/make'
import { holdIncremental } from './hold-incremental'
import { obligationKey, memoryObligationCache, diskObligationCache } from './obligation-cache'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const ROOT = process.cwd()
const resolve = projectResolver(ROOT, 'node', ROOT)
const VERSION = 'test-1'

// --- key behavior: same inputs -> same key; any change -> new key ---
const k1 = obligationKey({ source: 'a', deps: ['x', 'y'], version: VERSION })
const k2 = obligationKey({ source: 'a', deps: ['y', 'x'], version: VERSION }) // dep order must not matter
const k3 = obligationKey({ source: 'a', deps: ['x', 'z'], version: VERSION }) // a dep changed
const k4 = obligationKey({ source: 'a', deps: ['x', 'y'], version: 'test-2' }) // version changed
ok('key is stable + order-independent', k1 === k2)
ok('key changes when a dependency changes', k1 !== k3)
ok('key changes when the toolchain version changes', k1 !== k4)

// --- incremental over a real file in a temp project ---
const dir = mkdtempSync(path.join(tmpdir(), 'seed-hold-'))
const file = path.join(dir, 'sample.tree')
writeFileSync(file, 'task answer\n  like number\n  send back\n    mark 42\n')

const cache = memoryObligationCache()

// cold: must check
const cold = holdIncremental({ files: [file], resolve, cache, version: VERSION, cross: false })
ok('cold run checks the file', cold.checked === 1 && cold.cached === 0 && cold.ok)

// warm: must hit the cache (no re-check)
const warm = holdIncremental({ files: [file], resolve, cache, version: VERSION, cross: false })
ok('warm run hits the cache', warm.checked === 0 && warm.cached === 1 && warm.ok,
  `(${warm.cached} cached)`)

// change the file: must re-check (content hash differs)
writeFileSync(file, 'task answer\n  like number\n  send back\n    mark 43\n')
const changed = holdIncremental({ files: [file], resolve, cache, version: VERSION, cross: false })
ok('editing the file invalidates the cache', changed.checked === 1 && changed.cached === 0)

// bump the version: must re-check even with identical content
const bumped = holdIncremental({ files: [file], resolve, cache, version: 'test-2', cross: false })
ok('a version bump invalidates the cache', bumped.checked === 1 && bumped.cached === 0)

// --- disk persistence: a fresh cache object reads prior verdicts ---
const diskDir = path.join(dir, '.base/@cluesurf/term', 'hold')
const disk1 = diskObligationCache(diskDir)
holdIncremental({ files: [file], resolve, cache: disk1, version: VERSION, cross: false })
const disk2 = diskObligationCache(diskDir) // reopened: should load the saved entry
const persisted = holdIncremental({ files: [file], resolve, cache: disk2, version: VERSION, cross: false })
ok('disk cache persists across process boundaries', persisted.cached === 1 && persisted.checked === 0)

console.log(`\nseed-verify hold-cache demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
