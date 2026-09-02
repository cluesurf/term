// The parallel batch build driver (node). It fans the project's .tree files out across a pool of worker threads, each
// running the ordinary `compile()` on one file at a time, so routes / env / every whole-program transform is handled
// exactly as in the sequential `compileProject`. The on-disk `.base/@cluesurf/term/cache` is shared across workers, so the stdlib is
// parsed and milled once for the whole pool. Output is byte-identical to the sequential build; only the work is spread
// across cores. All filesystem writes stay on the main thread (workers only compile and post the emitted text back).
//
// This lives in its own module (not make.ts) so that the worker, which imports make.ts for the project resolver, never
// pulls esbuild (used here only to bundle the worker) into its own bundle.

import path from 'node:path'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { Worker } from 'node:worker_threads'
import { cpus, tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { buildSync } from 'esbuild'
import { compilerVersions } from '@term/call/code/cache-store'
import { findTreeFiles } from '@term/call/code/make'
import { stdlibBase } from '@term/make/code/resolve'

const HERE = path.dirname(fileURLToPath(import.meta.url))

// `import.meta.url` is `deck/call/code/` when running from source under tsx, but `host/`
// when running from the bundled CLI, where no `.ts` sits beside the bundle. So both the
// worker source and the package root are LOCATED rather than reached by a fixed number of
// `..` hops. Getting this wrong is silent: esbuild prints a resolve error and throws, the
// caller falls back to the sequential build, and the parallel path simply never runs.
function findUp(relative: string): string | undefined {
  let dir = HERE

  for (let level = 0; level < 8; level += 1) {
    const candidate = path.join(dir, relative)

    if (existsSync(candidate)) {
      return candidate
    }

    const parent = path.dirname(dir)

    if (parent === dir) {
      break
    }

    dir = parent
  }

  return undefined
}

const BUILD_WORKER_SOURCE =
  findUp('build-worker.ts') ?? findUp(path.join('deck', 'call', 'code', 'build-worker.ts'))

// the package root, whose tsconfig carries the `@term/...` path mappings
const TSCONFIG = findUp('tsconfig.json')

// bundle the per-file build worker once per process. worker_threads needs a runnable module path and does not inherit
// the tsx `@/` resolution, so esbuild bundles the worker (resolving `@/...` from the package tsconfig) into a
// self-contained ESM file under /tmp. Mirrors the per-definition pool's bundling.
let buildWorkerBundle: string | undefined

function ensureBuildWorkerBundle(): string {
  if (buildWorkerBundle) {
    return buildWorkerBundle
  }

  if (!BUILD_WORKER_SOURCE || !TSCONFIG) {
    // fail before esbuild does, so the caller's fallback is taken without esbuild first
    // printing a resolve error that looks like a broken build
    throw new Error(
      'parallel build unavailable: could not locate build-worker.ts or tsconfig.json',
    )
  }

  const out = path.join(tmpdir(), `seed-build-worker-${process.pid}.mjs`)
  buildSync({
    entryPoints: [BUILD_WORKER_SOURCE],
    outfile: out,
    bundle: true,
    platform: 'node',
    format: 'esm',
    tsconfig: TSCONFIG,
    // the worker imports make.ts for the project resolver, and make.ts dynamically imports THIS module for the parallel
    // build. The worker never runs that path, so keep this module (and the esbuild it pulls) out of the worker bundle
    // rather than bundling esbuild's native binary into a /tmp worker.
    external: ['@term/call/code/build-parallel'],
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
  options?: { concurrency?: number; env?: string; platform?: string },
): Promise<{ compiled: number; failed: number; errors: string[] }> {
  // the SAME selection the sequential build makes. A build targets one platform, and the
  // other platforms' native trees are not compiled: without this filter the pool picks up
  // every `native/<other>` tree and fails on code that was never meant to build here.
  // Defaults to the worker's own default env, so the two cannot drift apart.
  const platform = options?.platform ?? options?.env ?? 'node'
  const files = findTreeFiles(root, [], platform)

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
  // the worker bundle lives under /tmp, from where stdlibBase() cannot walk up to deck/seed: pin the stdlib for it
  // (worker_threads share process.env)
  const stdlib = stdlibBase()

  if (stdlib && !process.env.TERM_STDLIB) {
    process.env.TERM_STDLIB = stdlib
  }

  // The compiler version travels WITH the worker. A worker's own module is this bundle in the temp directory, so it
  // cannot find the package root to fingerprint the compiler, and left to itself it would key its cache under a hash
  // of the bundle and never read a single entry its parent wrote. See projectCache in cache-store.ts.
  const workers = Array.from(
    { length: size },
    () => new Worker(bundle, { workerData: { version: compilerVersions() } }),
  )

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
