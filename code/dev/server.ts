// The seed dev server (Tier 3). Compiles the app in per-module mode and serves each module lazily over native ESM, so
// cold start scales with the first route, not the whole app. A file change recompiles (the persistent cache makes it
// fast), walks the module graph to the nearest HMR boundary, and pushes an update over SSE (no websocket dependency).
// The transport is hono via @hono/node-server. See note/research/repo/vite/ and note/seed/plan/compilation-performance.md.

import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { SSEStreamingApi } from 'hono/streaming'
import { serve } from '@hono/node-server'
import { transformSync } from 'esbuild'
import { readFileSync, realpathSync } from 'fs'
import { compile } from '../compile/compile'
import { hashText } from '../compile/cache'
import { projectResolver } from '../call/make'
import { projectCache } from '../call/cache-store'
import { findProjectRoot } from '../call/boot'
import type { NativeEnv } from '../compile/native'
import { ModuleGraph } from './module-graph'
import { propagateUpdate, affectedModules } from './hmr'
import type { HmrResult } from './hmr'
import { devClient } from './client'

const MOD_PREFIX = '/@mod/'
const CLIENT_URL = '/@seed/client.mjs'
const HMR_URL = '/@seed/hmr'

export interface DevServer {
  port: number
  // recompile + apply HMR for a changed source file (the watcher calls this; exposed for tests)
  update(file: string): HmrResult
  close(): void
}

export interface DevOptions {
  root: string
  entry: string
  port?: number
  env?: NativeEnv
}

// start the dev server. Returns a handle with the port, a manual `update` (what the watcher calls), and `close`.
export function startDevServer(options: DevOptions): DevServer {
  const projectRoot = findProjectRoot(options.root)
  const env: NativeEnv = options.env ?? 'browser'
  const port = options.port ?? 5173
  const resolve = projectResolver(projectRoot, env)
  // canonicalize the entry so its graph-node id matches the watcher's realpath'd change events (deps are realpath'd by
  // the resolver already)
  const entryFile = realpathSync(options.entry)

  // a stable served URL per source file, and the reverse map for incoming requests
  const fileByHash = new Map<string, string>()
  const urlForFile = (file: string): string => {
    const id = hashText(file)
    fileByHash.set(id, file)
    return `${MOD_PREFIX}${id}.mjs`
  }

  const graph = new ModuleGraph()
  const clients = new Set<SSEStreamingApi>()
  const cache = projectCache(projectRoot)
  let clock = 1

  // (re)compile the whole app in per-module mode and sync the graph. The compile is whole-graph (cross-module type
  // checking needs every module), but serving is lazy and the shared cache (mill-level reuse) keeps recompiles fast.
  const build = (): boolean => {
    const result = compile(
      { file: entryFile, text: readFileSync(entryFile, 'utf8') },
      { resolve, cache, modules: urlForFile },
    )
    if (!result.ok || !result.modules) return false
    for (const [file, emit] of result.modules) {
      const node = graph.ensure(file, urlForFile(file), file)
      node.isSelfAccepting = emit.isZone
      node.loaded = true
      node.compiled = transformSync(emit.code, {
        loader: 'ts',
        format: 'esm',
      }).code
      const deps = emit.imports.map(dep =>
        graph.ensure(dep, urlForFile(dep), dep),
      )
      graph.setImports(node, deps)
    }
    return true
  }
  build()

  // push one HMR message to every connected client
  const broadcast = (message: unknown): void => {
    const data = JSON.stringify(message)
    for (const client of clients) void client.writeSSE({ data })
  }

  // recompile and decide the HMR action for a changed source file
  const update = (file: string): HmrResult => {
    clock += 1
    // invalidate the changed module and everything that imports it, then recompile
    for (const id of affectedModules(graph, file)) {
      const node = graph.getById(id)
      if (node) graph.invalidate(node, clock)
    }
    if (!build()) {
      broadcast({ type: 'full-reload' })
      return { type: 'full-reload' }
    }
    const result = propagateUpdate(graph, file)
    if (result.type === 'full-reload') {
      broadcast({ type: 'full-reload' })
    } else {
      // stamp each accepted module's URL with its hmr timestamp so the client re-imports a fresh copy
      const updates = result.updates.map(u => {
        const node = graph.getByUrl(u.accepted)
        const t = node?.lastHmrTimestamp || clock
        return { ...u, timestamp: t }
      })
      broadcast({ type: 'update', updates })
    }
    return result
  }

  // the served entry URL (the browser loads this as the app root module)
  const entryUrl = urlForFile(entryFile)

  const app = new Hono()

  // each compiled module, served as native ESM
  app.get(`${MOD_PREFIX}:name`, context => {
    const name = context.req.param('name').replace(/\.mjs$/, '')
    const file = fileByHash.get(name)
    const node = file ? graph.getById(file) : undefined
    if (!node || node.compiled === undefined)
      return context.text('module not found', 404)
    return context.body(node.compiled, 200, {
      'content-type': 'text/javascript',
    })
  })

  // the HMR client runtime
  app.get(CLIENT_URL, context =>
    context.body(devClient(HMR_URL), 200, {
      'content-type': 'text/javascript',
    }),
  )

  // the HMR event stream (SSE)
  app.get(HMR_URL, context =>
    streamSSE(context, async stream => {
      clients.add(stream)
      await stream.writeSSE({ data: JSON.stringify({ type: 'connected' }) })
      stream.onAbort(() => {
        clients.delete(stream)
      })
      // keep the stream open until the client disconnects
      while (!stream.aborted) await stream.sleep(10_000)
    }),
  )

  // the app shell: load the client + the entry module
  app.get('/', context =>
    context.html(
      `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>seed dev</title></head>\n  <body>\n    <script type="module" src="${CLIENT_URL}"></script>\n    <script type="module" src="${entryUrl}"></script>\n  </body>\n</html>\n`,
    ),
  )

  const server = serve({ fetch: app.fetch, port })
  return {
    port,
    update,
    close: () => {
      for (const client of clients) void client.close()
      clients.clear()
      server.close()
    },
  }
}
