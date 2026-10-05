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
import { compile } from '@term/make/code/compile/compile'
import { hashText } from '@term/make/code/term/hash'
import { projectResolver } from '@term/call/code/make'
import { projectCache } from '@term/call/code/cache-store'
import { findProjectRoot } from '@term/call/code/boot'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import type { NativeEnv } from '@term/make/code/compile/native'
import {
  ensureModule,
  hasModule,
  hasUrl,
  invalidateModule,
  makeModuleGraph,
  moduleById,
  moduleByUrl,
  putModule,
  setImports,
} from '@term/make/code/dev/module-graph'
import {
  propagateUpdate,
  affectedModules,
} from '@term/make/code/dev/hmr'
import type { HmrResult } from '@term/make/code/dev/hmr'
import { devClient } from '@term/make/code/dev/client'

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
  // a page entry that exports a `boot` task and nothing calls: the shell calls it once the module is loaded. A cask
  // app's page is one; a `hook` route table boots itself and leaves this unset
  boot?: boolean
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

  // the graph is a value (deck/make/code/dev/module-graph.tree): every change hands back the next one
  let graph = makeModuleGraph()
  const clients = new Set<SSEStreamingApi>()
  const cache = projectCache(projectRoot)

  let clock = 1

  // (re)compile the whole app in per-module mode and sync the graph. The compile is whole-graph (cross-module type
  // checking needs every module), but serving is lazy and the shared cache (mill-level reuse) keeps recompiles fast.
  // returns the compile error messages (empty array on success), so a failed recompile can be reported to the client
  // as an overlay instead of forcing a state-losing reload
  const build = (): string[] => {
    // the role and the lean reading, as `term make` reads them: without them a `mark lean` module was read as
    // longhand (guides: commands/feed, 2026-10-04)
    const result = compile(
      { file: entryFile, text: readFileSync(entryFile, 'utf8') },
      { resolve, cache, modules: urlForFile, roleOf: projectRoleOf(projectRoot), leanOf: projectLeanOf(projectRoot) },
    )

    if (!result.ok) {
      return result.diagnostics.map(d => d.message)
    }

    if (!result.modules) {
      return ['the build produced no modules']
    }

    for (const [file, emit] of result.modules) {
      graph = ensureModule(graph, file, urlForFile(file), file)
      graph = putModule(graph, {
        ...moduleById(graph, file),
        isSelfAccepting: emit.isZone,
        loaded: true,
        compiled: transformSync(emit.code, {
          loader: 'ts',
          format: 'esm',
        }).code,
      })

      for (const dep of emit.imports) {
        graph = ensureModule(graph, dep, urlForFile(dep), dep)
      }

      graph = setImports(graph, file, emit.imports).graph
    }

    return []
  }

  build()

  // push one HMR message to every connected client
  const broadcast = (message: unknown): void => {
    const data = JSON.stringify(message)

    for (const client of clients) {
      void client.writeSSE({ data })
    }
  }

  // recompile and decide the HMR action for a changed source file
  const update = (file: string): HmrResult => {
    clock += 1

    // invalidate the changed module and everything that imports it, then recompile
    for (const id of affectedModules(graph, file)) {
      graph = invalidateModule(graph, id, clock)
    }

    const errors = build()

    if (errors.length) {
      // recovery: keep the running app on its last-good code and state, push an error overlay instead of reloading
      broadcast({ type: 'error', errors })

      return { type: 'error', errors }
    }

    const result = propagateUpdate(graph, file)

    if (result.type !== 'update') {
      broadcast({ type: 'full-reload' })
    } else {
      // stamp each accepted module's URL with its hmr timestamp so the client re-imports a fresh copy
      const updates = result.updates.map(u => {
        const t = (hasUrl(graph, u.accepted) ? moduleByUrl(graph, u.accepted).lastHmrTimestamp : 0) || clock

        return { ...u, timestamp: t }
      })

      broadcast({ type: 'update', updates })
    }

    return result
  }

  // the served entry URL (the browser loads this as the app root module)
  const entryUrl = urlForFile(entryFile)

  const app = new Hono()

  // Only this machine may ask (native-dom-0018, after Tauri 2.12's dev-server fix). A page anywhere on the web can
  // point a name it controls at 127.0.0.1 and then read this server as its own origin (DNS rebinding), and a
  // cross-site page can open the HMR stream. So a request whose Host is not a loopback name is refused, and so is
  // one whose Origin is some other site. `10.0.2.2` is how the Android emulator reaches this machine's loopback, and
  // the iOS simulator shares the host's network, so the cask's dev loop still works. TERM_DEV_HOSTS (comma-separated)
  // adds names, for a real device on the local network.
  const allowedHosts = new Set([
    'localhost',
    '127.0.0.1',
    '[::1]',
    '10.0.2.2',
    ...(process.env.TERM_DEV_HOSTS ?? '').split(',').map(name => name.trim()).filter(Boolean),
  ])
  const hostName = (value: string): string => (value.startsWith('[') ? value.slice(0, value.indexOf(']') + 1) : value.split(':')[0]!)

  app.use('*', async (context, next) => {
    const host = context.req.header('host') ?? ''

    if (!allowedHosts.has(hostName(host))) {
      return context.text(`refused: the dev server answers this machine only, not host ${host || '(none)'}`, 403)
    }

    const origin = context.req.header('origin')

    if (origin) {
      let originHost = ''

      try {
        originHost = new URL(origin).host
      } catch {
        originHost = ''
      }

      if (!allowedHosts.has(hostName(originHost))) {
        return context.text(`refused: a page from ${origin} may not read the dev server`, 403)
      }
    }

    return next()
  })

  // each compiled module, served as native ESM
  app.get(`${MOD_PREFIX}:name`, context => {
    const name = context.req.param('name').replace(/\.mjs$/, '')
    const file = fileByHash.get(name)
    // a module never compiled, or invalidated and not yet rebuilt, holds `<>` where the original held undefined
    const compiled = file && hasModule(graph, file) ? moduleById(graph, file).compiled : ''

    if (compiled === '') {
      return context.text('module not found', 404)
    }

    return context.body(compiled, 200, {
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
      await stream.writeSSE({
        data: JSON.stringify({ type: 'connected' }),
      })
      stream.onAbort(() => {
        clients.delete(stream)
      })

      // keep the stream open until the client disconnects
      while (!stream.aborted) {
        await stream.sleep(10_000)
      }
    }),
  )

  // the app shell: load the client + the entry module
  app.get('/', context =>
    context.html(
      `<!doctype html>\n<html>\n  <head><meta charset="utf-8" /><title>term dev</title></head>\n  <body>\n    <script type="module" src="${CLIENT_URL}"></script>\n    <script type="module" src="${entryUrl}"></script>\n${options.boot ? `    <script type="module">import { boot } from "${entryUrl}"; boot()</script>\n` : ''}  </body>\n</html>\n`,
    ),
  )

  // loopback only: nothing on the network can reach it at all, whatever it sends as Host
  const server = serve({ fetch: app.fetch, port, hostname: '127.0.0.1' })

  return {
    port,
    update,
    close: () => {
      for (const client of clients) {
        void client.close()
      }

      clients.clear()
      server.close()
    },
  }
}
