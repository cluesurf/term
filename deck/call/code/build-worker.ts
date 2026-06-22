// The per-file build worker (node, `worker_threads`). The batch compiler fans the project's .tree files out across a
// pool of these: each worker compiles one whole file at a time through the ordinary `compile()` path, so routes, env
// binds, and every other whole-program transform are handled exactly as in a sequential build. The project's on-disk
// cache (`.seed/cache`) is shared across workers, so the stdlib is parsed and milled once for the whole pool, not once
// per worker. The worker reads the file itself (the driver sends only the path) and posts back the emitted output.

import { parentPort } from 'node:worker_threads'
import { readFileSync } from 'node:fs'
import { relative } from 'node:path'
import { compile } from '@cluesurf/make/code/compile/compile'
import { projectResolver } from '@cluesurf/call/code/make'
import { projectCache } from '@cluesurf/call/code/cache-store'
import type { CompileCache } from '@cluesurf/make/code/compile/cache'
import type { Resolver } from '@cluesurf/make/code/compile/load'

type JobMessage = {
  type: 'job'
  id: number
  root: string
  file: string
  env?: string
}

// the resolver and shared cache are built once per project root and reused for every file the worker handles
let activeRoot: string | undefined
let resolve: Resolver | undefined
let cache: CompileCache | undefined

function ready(root: string): void {
  if (activeRoot === root && resolve && cache) {
    return
  }

  activeRoot = root
  resolve = projectResolver(root)
  cache = projectCache(root)
}

parentPort?.on('message', (message: JobMessage) => {
  if (message.type !== 'job') {
    return
  }

  const { id, root, file, env } = message

  try {
    ready(root)

    const text = readFileSync(file, 'utf8')
    const result = compile(
      { file, text },
      { resolve, cache, env },
    )

    if (!result.ok) {
      const first = result.diagnostics[0]

      parentPort!.postMessage({
        id,
        file,
        ok: false,
        error: `${relative(root, file)}: ${
          first ? `${first.name}: ${first.message}` : 'compile failed'
        }`,
      })

      return
    }

    const isCss = typeof result.css === 'string'

    parentPort!.postMessage({
      id,
      file,
      ok: true,
      isCss,
      output: isCss ? result.css : result.typescript,
    })
  } catch (error) {
    parentPort!.postMessage({
      id,
      file,
      ok: false,
      error: `${relative(root, file)}: ${String(error)}`,
    })
  }
})
