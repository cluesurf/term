// The unit build worker (node, `worker_threads`), for the parallel separate build (build-separate-parallel.ts). Each
// job is one module compiled as its own entry through `compileSeparate`, which is exactly the answer every other
// entry reaching that module looks up: a one-file unit is checked as itself whichever entry reached it. The driver
// sends a module only once every unit it depends on is built, so its dependencies are answered from the cache the
// pool shares on disk, and its own answer is there for the modules after it. A project file's answer travels back
// whole, so the parent writes it without compiling it again; a module from outside the project is built for the cache
// alone.

import { parentPort, workerData } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { compileSeparate } from '@term/make/code/compile/separate'
import { buildable, buildSession, entryShim, isWholeFile, unitSlug } from '@term/call/code/make'
import type { BuildSession } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import type { CompileCache } from '@term/make/code/compile/cache'
import { projectDeckOf } from '@term/call/code/deck-of'
import { projectRoleOf, projectLeanOf } from '@term/call/code/role-of'
import type { RoleOf } from '@term/call/code/role-of'
import type { DeckOf } from '@term/make/code/compile/roll'

type Job = { type: 'job'; root: string; file: string; entry: boolean }

// what one worker holds in memory: milled modules, and unit answers. Enough for @term/bind's whole closure, about
// 3,700 modules: at 512 every job read the standard library's mills back from disk, and eight workers spent 2,500 s of
// CPU on what one thread built in 400. The worker that ran out of memory held every answer's closure for the parent,
// which it no longer does
const WORKER_MILLS = 4096
const WORKER_UNITS = 8000

// the compiler fingerprint per cache kind, handed down by the parent: a bundle in the temp directory cannot find the
// package root to work it out (see build-worker.ts)
const VERSION = (workerData as { version?: Record<string, string> } | undefined)?.version

let root: string | undefined
let session: BuildSession | undefined
let cache: CompileCache | undefined
let deckOf: DeckOf | undefined
let roleOf: RoleOf | undefined
let leanOf: ((file: string) => boolean) | undefined
// the modules whose code this worker has sent the parent already, and the units whose roll it has
let sent = new Set<string>()
let sentRolls = new Set<string>()

function ready(at: string): void {
  if (root === at) {
    return
  }

  root = at
  sent = new Set()
  sentRolls = new Set()
  session = buildSession(at)
  // a few hundred milled modules in memory, not the default thousands: every worker of the pool holds its own
  cache = projectCache(at, VERSION, WORKER_MILLS)
  deckOf = projectDeckOf()
  roleOf = projectRoleOf(at)
  leanOf = projectLeanOf(at)
}

parentPort?.on('message', (job: Job) => {
  if (job.type !== 'job') {
    return
  }

  try {
    ready(job.root)

    // the unit answers this worker has read, bounded like its mills: past the cap they are read from the cache again
    if (session!.units.size > WORKER_UNITS) {
      session!.units.clear()
    }

    let text = readFileSync(job.file, 'utf8')

    // a project file is read as compileProjectSeparate reads it: a file of tests rewritten, a grammar generated, and
    // a file that is not a program left to the parent, which compiles it whole
    if (job.entry) {
      const unit = buildable(job.file, text, roleOf!(job.file))

      if ('faults' in unit || isWholeFile(job.file, unit.text, roleOf!(job.file))) {
        parentPort!.postMessage({ file: job.file })

        return
      }

      text = unit.text
    }

    // what this job spent building units and computing the roll, which the pool's line reports summed
    const builtAt = Date.now()
    const result = compileSeparate(
      { file: job.file, text },
      {
        resolve: session!.resolve,
        cache,
        modules: f => `./${unitSlug(job.root, f, deckOf!)}`,
        roleOf: roleOf!,
        leanOf: leanOf!,
        deckOf: deckOf!,
        parsed: session!.parsed,
        units: session!.units,
        walked: session!.walked,
      },
    )

    const building = Date.now() - builtAt
    const rolledAt = Date.now()

    // no roll here: the project's roll is assembled from each unit's own roll and reach, which came back with the
    // answer (call/code/roll.ts `projectRoll`). It was each entry's roll, a typing of its whole closure, 481 to 641 s
    // of the workers' time on a cold @term/bind, and then each entry's shake, 372 s (2026-10-05)

    const spent = { building, rolling: Date.now() - rolledAt }

    // each module's code once per worker: an entry's answer carries every module of its closure, and on @term/bind
    // 3,091 answers each holding the standard library's 600 modules was more than the parent could hold. The parent
    // writes a module the first time any answer carries it, so one copy is all it needs. And the entry's shim as the
    // text it is, in place of every public name of its closure it is made from
    if (job.entry && result.ok) {
      const fresh = new Map([...result.modules].filter(([file]) => !sent.has(file)))
      fresh.forEach((_, file) => sent.add(file))

      // and each unit's roll once, as each module's code is
      const rolls = result.rolls.filter(([label]) => !sentRolls.has(label))
      rolls.forEach(([label]) => sentRolls.add(label))

      const shim = entryShim(job.root, job.file, result.exports, file => unitSlug(job.root, file, deckOf!))
      parentPort!.postMessage({ file: job.file, result: { ...result, modules: fresh, rolls, exports: [], shim }, built: result.built.length, spent })

      return
    }

    parentPort!.postMessage({ file: job.file, result: job.entry ? result : undefined, built: result.ok ? result.built.length : 0, spent })
  } catch (error) {
    parentPort!.postMessage({ file: job.file, error: String((error as Error)?.stack ?? error) })
  }
})
