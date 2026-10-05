// THE PARALLEL SEPARATE BUILD (note/term/plan/incremental-best-in-class.md, step 5).
//
// The separate build checks one unit at a time, a module or a cycle of modules, against the stubs of the units it
// reaches (compile/separate.ts). Units that do not reach one another can be checked at once, and on @term/bind that is
// most of them. This walks every entry's closure on the main thread, cuts the union of the closures into its units,
// and hands each unit to a pool of workers (separate-worker.ts) the moment every unit it reaches is built
// (compile/schedule.tree). Each worker compiles the unit's module as its own entry, which is the answer every entry
// reaching it looks up, and leaves it in the cache the pool shares on disk.
//
// A project file's answer comes back whole, and `compileProjectSeparate` takes it as built: it writes the artifacts
// and reports the problems on the main thread, as it does for an entry it compiles itself. Anything the pool did not
// answer, it compiles. So a pool that fails part way costs time, never a wrong build.
//
// It lives apart from make.ts so that the worker, which imports make.ts, never bundles esbuild.

import { readFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { cpus } from 'node:os'
import { compilerVersions, projectCache } from '@term/call/code/cache-store'
import { buildable, isWholeFile } from '@term/call/code/make'
import type { BuildSession } from '@term/call/code/make'
import { bundleWorker } from '@term/call/code/build-parallel'
import { collectModules } from '@term/make/code/compile/load'
import { units as unitsOf } from '@term/make/code/compile/separate'
import type { SeparateResult } from '@term/make/code/compile/separate'
import { finish, first, makeSchedule } from '@term/make/code/compile/schedule'
import { stdlibBase } from '@term/make/code/resolve'
import { projectRoleOf } from '@term/call/code/role-of'

type Reply = { file: string; result?: SeparateResult; error?: string; built?: number }

export async function compileUnitsParallel(
  root: string,
  files: string[],
  session: BuildSession,
  options?: { concurrency?: number },
): Promise<{
  results: Map<string, SeparateResult>
  jobs: number
  workers: number
  failures: string[]
  // the units built for modules outside the project, which no entry's answer counts
  built: number
}> {
  const cache = projectCache(root)
  const roleOf = projectRoleOf(root)

  // every program entry's closure, walked once through the session, so the main build after this walks nothing new
  const entries = new Set<string>()
  const modules = new Set<string>()

  for (const file of files) {
    const unit = buildable(file, readFileSync(file, 'utf8'), roleOf(file))

    if ('faults' in unit || isWholeFile(file, unit.text, roleOf(file))) {
      continue
    }

    entries.add(file)

    const walked = collectModules(
      { file, text: unit.text },
      session.resolve,
      session.parsed,
      (source, compute) => cache.scanned(source.file, source.text, compute),
      session.walked,
    )

    for (const source of walked.sources) {
      modules.add(source.file)
    }
  }

  // the union of the closures, cut into units, each named by its first file. A unit's job is that file compiled as its
  // own entry. A project file a cycle holds beside another is its own entry too, once the cycle is built, since an
  // entry checks its unit as itself
  const edges = new Map<string, string[]>()

  for (const file of modules) {
    edges.set(file, (session.walked.get(file)?.edges ?? []).filter(edge => modules.has(edge)))
  }

  const units = unitsOf([...modules], edges)
  const unitOf = new Map<string, string>()

  for (const unit of units) {
    for (const file of unit) {
      unitOf.set(file, unit[0]!)
    }
  }

  const graph = new Map<string, string[]>()

  for (const unit of units) {
    const deps = new Set<string>()

    for (const file of unit) {
      for (const edge of edges.get(file) ?? []) {
        const dep = unitOf.get(edge)!

        if (dep !== unit[0]) {
          deps.add(dep)
        }
      }
    }

    graph.set(unit[0]!, [...deps])

    for (const file of unit.slice(1)) {
      if (entries.has(file)) {
        graph.set(file, [unit[0]!])
      }
    }
  }

  // at most eight: each worker holds every unit it has read, which on @term/bind is the standard library and more, and
  // fourteen of them held more than the machine had
  const size = Math.max(1, Math.min(options?.concurrency ?? Math.min(8, Math.max(1, cpus().length - 1)), graph.size))
  const bundle = bundleWorker('separate-worker')
  const stdlib = stdlibBase()

  // the worker bundle lives in the temp directory, from where stdlibBase() cannot walk up to the standard library
  if (stdlib && !process.env.TERM_STDLIB) {
    process.env.TERM_STDLIB = stdlib
  }

  const workers = Array.from({ length: size }, () => new Worker(bundle, { workerData: { version: compilerVersions() } }))
  const plan = makeSchedule(graph)
  const ready = first(plan)
  const results = new Map<string, SeparateResult>()
  const failures: string[] = []
  const idle: Worker[] = []
  // the job each busy worker holds
  const holding = new Map<Worker, string>()
  let alive = workers.length
  let done = 0
  let built = 0

  await new Promise<void>(settle => {
    const dispatch = (): void => {
      while (idle.length > 0 && ready.length > 0) {
        const file = ready.shift()!
        const worker = idle.pop()!
        holding.set(worker, file)
        worker.postMessage({ type: 'job', root, file, entry: entries.has(file) })
      }

      // every job answered, or nobody left to answer the rest, which the main build then compiles itself
      if (done === graph.size || alive === 0) {
        settle()
      }
    }

    // a unit that failed still releases what waits on it: each of those then fails or builds on its own terms, as it
    // would in the sequential build, and the main build compiles whatever has no answer here
    const release = (file: string): void => {
      done++
      ready.push(...finish(plan, file))
    }

    for (const worker of workers) {
      worker.on('message', (reply: Reply) => {
        holding.delete(worker)

        if (reply.result) {
          results.set(reply.file, reply.result)
        } else {
          built += reply.built ?? 0
        }

        if (reply.error) {
          failures.push(`${reply.file}: ${reply.error}`)
        }

        release(reply.file)
        idle.push(worker)
        dispatch()
      })

      // a worker that dies takes its job with it: the job is released with no answer, and the pool goes on without
      // that worker
      worker.on('error', error => {
        const file = holding.get(worker)
        holding.delete(worker)
        if (idle.includes(worker)) {
          idle.splice(idle.indexOf(worker), 1)
        }

        alive--
        failures.push(`${file ?? '<worker>'}: ${String(error)}`)

        if (file !== undefined) {
          release(file)
        }

        dispatch()
      })

      idle.push(worker)
    }

    dispatch()
  })

  await Promise.all(workers.map(worker => worker.terminate()))

  return { results, jobs: graph.size, workers: size, failures, built }
}
