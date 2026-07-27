// The parallel batch build driver (node). It fans the project's .tree files out across a pool of worker threads, each
// running the ordinary `compile()` on one file at a time, so routes / env / every whole-program transform is handled
// exactly as in the sequential `compileProject`. The on-disk `.base/term/cache` is shared across workers, so the stdlib is
// parsed and milled once for the whole pool. Output is byte-identical to the sequential build; only the work is spread
// across cores. All filesystem writes stay on the main thread (workers only compile and post the emitted text back).
//
// This lives in its own module (not make.ts) so that the worker, which imports make.ts for the project resolver, never
// pulls esbuild (used here only to bundle the worker) into its own bundle.

import path from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { cpus, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { findTreeFiles } from '@cluesurf/call/code/make'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BUILD_WORKER_SOURCE = path.join(HERE, 'build-worker.ts')
// the seed package root (three levels up from deck/call/code/), whose tsconfig carries the package path mappings
const SEED_ROOT = path.resolve(HERE, '..', '..', '..')

// bundle the per-file build worker once per process. worker_threads needs a runnable module path and does not inherit
// the tsx `@/` resolution, so esbuild bundles the worker (resolving `@/...` from the package tsconfig) into a
// self-contained ESM file under /tmp. Mirrors the per-definition pool's bundling.
let buildWorkerBundle: string | undefined

function ensureBuildWorkerBundle(): string {
  if (buildWorkerBundle) {
    return buildWorkerBundle
  }

  const out = path.join(tmpdir(), `seed-build-worker-${process.pid}.mjs`)
  buildSync({
    entryPoints: [BUILD_WORKER_SOURCE],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: path.join(SEED_ROOT, 'tsconfig.json'),
    // the worker imports make.ts for the project resolver, and make.ts dynamically imports THIS module for the parallel
    // build. The worker never runs that path, so keep this module (and the esbuild it pulls) out of the worker bundle
    // rather than bundling esbuild's native binary into a /tmp worker.
    external: ['@cluesurf/call/code/build-parallel'],
    // a CJS module in the compiler graph uses `require(...)` (e.g. a node builtin); esbuild's ESM output does not shim
    // dynamic require, so define one from import.meta.url. Without this the worker dies with "Dynamic require not supported".
    banner: {
      js: "import { createRequire as __seedCreateRequire } from 'module'; const require = __seedCreateRequire(import.meta.url);",
    },
  })
  buildWorkerBundle = out

  return out
}

type Reply = {
  file: string
  ok: boolean
  isCss?: boolean
  output?: string
  error?: string
}

export function compileProjectParallel(
  root: string,
  options?: { concurrency?: number; env?: string },
): Promise<{ compiled: number; failed: number; errors: string[] }> {
  const files = findTreeFiles(root)

  if (files.length === 0) {
    return Promise.resolve({ compiled: 0, failed: 0, errors: [] })
  }

  const size = Math.max(
    1,
    Math.min(
      options?.concurrency ?? Math.max(1, cpus().length - 1),
      files.length,
    ),
  )

  const bundle = ensureBuildWorkerBundle()
  const workers = Array.from({ length: size }, () => new Worker(bundle))

  let compiled = 0
  let failed = 0
  const errors: string[] = []
  let next = 0
  let done = 0

  const write = (reply: Reply): void => {
    if (reply.ok) {
      const outPath = path.join(
        root,
        'host',
        path
          .relative(root, reply.file)
          .replace(/\.tree$/, reply.isCss ? '.css' : '.ts'),
      )

      mkdirSync(path.dirname(outPath), { recursive: true })
      writeFileSync(outPath, reply.output ?? '')
      compiled++
    } else {
      failed++
      errors.push(reply.error ?? `${reply.file}: compile failed`)
    }
  }

  const run = new Promise<void>(finish => {
    const dispatch = (worker: Worker): void => {
      if (next >= files.length) {
        return
      }

      const file = files[next++]!
      worker.postMessage({
        type: 'job',
        id: next,
        root,
        file,
        env: options?.env,
      })
    }

    const settle = (reply: Reply): void => {
      write(reply)
      done++

      if (done === files.length) {
        finish()
      }
    }

    for (const worker of workers) {
      worker.on('message', (reply: Reply) => {
        settle(reply)
        dispatch(worker)
      })
      // a worker that dies mid-job: surface it as a build failure rather than hanging the pool
      worker.on('error', error =>
        settle({ file: '<worker>', ok: false, error: String(error) }),
      )
    }

    for (const worker of workers) {
      dispatch(worker)
    }
  })

  return run
    .then(() => Promise.all(workers.map(worker => worker.terminate())))
    .then(() => ({ compiled, failed, errors }))
}
