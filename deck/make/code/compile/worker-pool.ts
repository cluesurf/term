// The parallel per-definition worker pool (node). A fixed set of `worker_threads` each cache the shared build context
// (the global scope + bodies-stripped signature context, sent once per revision) and process one Def job at a time:
// resolve + infer + emit that function. The pool dispatches a job to the next free worker and resolves its promise on
// the reply. `emitProgramParallel` orchestrates a whole program: it builds the context once and fans the functions out
// across the pool (or runs them inline when no pool is given). Node-only. See note/seed/compiler/parallel-worker-pool.md.

import { Worker } from 'node:worker_threads'
import { cpus, tmpdir } from 'node:os'
import { rmSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import * as path from 'node:path'
import { buildSync } from 'esbuild'
import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { emitTypeScript } from '@cluesurf/make/code/compile/typescript'
import type {
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'
import {
  processDef,
  buildDefContext,
} from '@cluesurf/make/code/compile/def-pass'
import type {
  DefContext,
  DefOutput,
} from '@cluesurf/make/code/compile/def-pass'
import type { Scope } from '@cluesurf/make/code/check/resolve'

type FunctionDef = Extract<Statement, { form: 'function' }>

// one Def's compiled result plus the worker thread that produced it (for observability / tests)
export interface DefResult extends DefOutput {
  name: string
  threadId: number
}

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER_SOURCE = path.join(HERE, 'def-worker.ts')
// the seed package root (four levels up from deck/make/code/compile/), whose tsconfig carries the package path mappings
const SEED_ROOT = path.resolve(HERE, '..', '..', '..', '..')

// `worker_threads` needs a runnable module path, and a worker thread does not inherit the tsx `@/` path resolution.
// So bundle the worker once per process with esbuild (which resolves `@/` from the tsconfig) into a self-contained
// ESM file. This keeps every source import as `@/...` (no relative / `.js` rewriting) and works the same whether the
// host is tsx (dev / test) or the published CLI. Node builtins + node_modules stay external.
let workerBundle: string | undefined
function ensureWorkerBundle(): string {
  if (workerBundle) return workerBundle
  const out = path.join(tmpdir(), `seed-def-worker-${process.pid}.mjs`)
  // bundle node_modules in (the worker's graph is the pure compiler passes plus chalk), so the output is fully
  // self-contained and resolves from /tmp. Node builtins stay external (platform: node).
  buildSync({
    entryPoints: [WORKER_SOURCE],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: path.join(SEED_ROOT, 'tsconfig.json'),
  })
  workerBundle = out
  return out
}

type WorkerEntry = {
  worker: Worker
  busy: boolean
  // the context revision this worker currently holds (-1 = none), so the pool only re-sends the context on a change
  revision: number
}

type Pending = {
  resolve: (result: DefResult) => void
  reject: (error: Error) => void
  source: FunctionDef
  revision: number
}

export class WorkerPool {
  private readonly workers: Array<WorkerEntry> = []
  private readonly queue: Array<{ id: number; pending: Pending }> = []
  private readonly pending = new Map<number, Pending>()
  private nextId = 1
  // the current shared context, broadcast lazily to each worker before its first job of this revision
  private revision = 0
  private context: DefContext | undefined

  constructor(size: number = Math.max(1, cpus().length - 1)) {
    const bundle = ensureWorkerBundle()
    for (let i = 0; i < size; i++) {
      const worker = new Worker(bundle)
      const entry: WorkerEntry = { worker, busy: false, revision: -1 }
      worker.on('message', message => this.onMessage(entry, message))
      worker.on('error', error => this.onError(error))
      this.workers.push(entry)
    }
  }

  // set the shared build context for subsequent jobs. Cheap: it only bumps the revision; each worker is sent the new
  // context lazily, right before its next job.
  setContext(context: DefContext): void {
    this.revision += 1
    this.context = context
  }

  // process one function: queue it, then drain the queue onto free workers
  run(source: FunctionDef): Promise<DefResult> {
    return new Promise<DefResult>((resolve, reject) => {
      const id = this.nextId++
      const pending: Pending = {
        resolve,
        reject,
        source,
        revision: this.revision,
      }
      this.pending.set(id, pending)
      this.queue.push({ id, pending })
      this.drain()
    })
  }

  private drain(): void {
    for (const entry of this.workers) {
      if (entry.busy) continue
      const next = this.queue.shift()
      if (!next) return
      entry.busy = true
      // send the context first if this worker does not already hold the current revision
      if (entry.revision !== next.pending.revision && this.context) {
        entry.worker.postMessage({
          type: 'context',
          revision: next.pending.revision,
          context: this.context,
        })
        entry.revision = next.pending.revision
      }
      entry.worker.postMessage({
        type: 'job',
        id: next.id,
        revision: next.pending.revision,
        source: next.pending.source,
      })
      // remember which worker owns which id, so the reply frees the right one
      ;(entry as WorkerEntry & { current?: number }).current = next.id
    }
  }

  private onMessage(entry: WorkerEntry, message: unknown): void {
    const msg = message as
      | {
          type: 'result'
          id: number
          name: string
          typed: FunctionDef
          diagnostics: Array<Diagnostic>
          ts: string
          threadId: number
        }
      | { type: 'needContext'; id: number }
    if (msg.type === 'needContext') {
      // the worker lacks this revision's context: send it, then re-dispatch the same job
      const pending = this.pending.get(msg.id)
      if (pending && this.context) {
        entry.worker.postMessage({
          type: 'context',
          revision: pending.revision,
          context: this.context,
        })
        entry.revision = pending.revision
        entry.worker.postMessage({
          type: 'job',
          id: msg.id,
          revision: pending.revision,
          source: pending.source,
        })
      }
      return
    }
    const pending = this.pending.get(msg.id)
    entry.busy = false
    if (pending) {
      this.pending.delete(msg.id)
      pending.resolve({
        name: msg.name,
        typed: msg.typed,
        diagnostics: msg.diagnostics,
        ts: msg.ts,
        threadId: msg.threadId,
      })
    }
    this.drain()
  }

  private onError(error: Error): void {
    // a worker crash rejects every outstanding job: the caller falls back or fails the build, never hangs
    for (const [id, pending] of this.pending) {
      pending.reject(error)
      this.pending.delete(id)
    }
  }

  async close(): Promise<void> {
    await Promise.all(
      this.workers.map(entry => entry.worker.terminate()),
    )
    // drop the bundled worker file so it does not linger in the temp dir; a later pool re-bundles on demand. Workers
    // already loaded it into memory, so removing the file never affects a still-running pool.
    if (workerBundle) {
      try {
        rmSync(workerBundle, { force: true })
      } catch {
        // a missing / already-removed bundle is fine
      }
      workerBundle = undefined
    }
  }
}

// the result of a parallel program build: the assembled TypeScript and the diagnostics, in program order
export interface ParallelEmit {
  ts: string
  diagnostics: Array<Diagnostic>
  // the distinct worker thread ids that contributed (empty for an inline build), for observability / tests
  threads: Array<number>
}

// emit a whole program's TypeScript by compiling each function definition in parallel. With a `pool`, the per-Def work
// runs on worker threads; without one, it runs inline on the main thread (the reference path). Either way the output
// is assembled in program order, so the result is identical and deterministic.
export async function emitProgramParallel(
  program: Program,
  buildScope: (program: Program) => Scope,
  pool?: WorkerPool,
): Promise<ParallelEmit> {
  const context = buildDefContext(program, buildScope)
  if (pool) pool.setContext(context)

  const functions = program.filter(
    (s): s is FunctionDef => s.form === 'function',
  )
  const others = program.filter(s => s.form !== 'function')

  const results = await Promise.all(
    functions.map(fn =>
      pool
        ? pool.run(fn)
        : Promise.resolve<DefResult>({
            ...processDef(fn, context),
            name: fn.name,
            threadId: 0,
          }),
    ),
  )

  const parts: Array<string> = []
  if (others.length) parts.push(emitTypeScript(others))
  const diagnostics: Array<Diagnostic> = []
  const threads = new Set<number>()
  for (const result of results) {
    if (result.ts) parts.push(result.ts)
    diagnostics.push(...result.diagnostics)
    if (result.threadId) threads.add(result.threadId)
  }

  return {
    ts: parts.filter(p => p.length > 0).join('\n\n'),
    diagnostics,
    threads: [...threads],
  }
}
