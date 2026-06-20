// Watch + hot-reload: keep the compiled AST mesh warm across edits and recompile only what changed. `IncrementalCompiler`
// is the pure, browser-safe core: it holds one `CompileCache` across compiles, so an unchanged module reuses its
// parse + mill (and an unchanged module graph returns its whole result instantly). `watch` is the thin node-only
// shell that pumps file-system events into it. See compile/cache.ts (the two-level cache) and the LSP server, which
// uses the same incremental path on every keystroke.

import { watch as fsWatch, readFileSync } from 'node:fs'
import { compile } from '@/code/compile/compile'
import type { CompileResult } from '@/code/compile/compile'
import { CompileCache } from '@/code/compile/cache'
import type { Resolver, Source } from '@/code/compile/load'

// the in-memory compiled mesh: a long-lived compiler whose cache survives across recompiles, so each edit only
// recomputes the modules that actually changed
export class IncrementalCompiler {
  private readonly cache = new CompileCache()

  constructor(private readonly resolve?: Resolver) {}

  // compile the entry (and everything it loads) reusing the warm cache. Fast on an unchanged or near-unchanged graph.
  compile(entry: Source): CompileResult {
    return compile(entry, { resolve: this.resolve, cache: this.cache })
  }

  // cache observability: how many parse+mill / whole-graph lookups were reused vs rebuilt since construction
  get stats(): { hits: number; misses: number } {
    return { hits: this.cache.hits, misses: this.cache.misses }
  }
}

export type Watcher = { close: () => void }

// watch a directory tree of `.tree` files; on any change, recompile the entry incrementally and hand the result to
// `onResult`. Changes are debounced so a burst of saves triggers a single recompile. Returns a stop handle.
export function watch(options: {
  root: string
  entry: string
  resolve?: Resolver
  onResult: (result: CompileResult, changed: string | null) => void
  debounceMs?: number
}): Watcher {
  const { root, entry, resolve, onResult, debounceMs = 30 } = options
  const compiler = new IncrementalCompiler(resolve)
  const recompile = (changed: string | null): void => {
    onResult(
      compiler.compile({
        file: entry,
        text: readFileSync(entry, 'utf8'),
      }),
      changed,
    )
  }

  recompile(null) // the initial build warms the cache

  let timer: ReturnType<typeof setTimeout> | undefined
  const fsWatcher = fsWatch(
    root,
    { recursive: true },
    (_event, filename) => {
      const name = typeof filename === 'string' ? filename : ''
      if (!name.endsWith('.tree')) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => recompile(name), debounceMs)
    },
  )

  return {
    close: () => {
      if (timer) clearTimeout(timer)
      fsWatcher.close()
    },
  }
}
