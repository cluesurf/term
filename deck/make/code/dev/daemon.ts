// The seed daemon (Tier 4): a long-lived process hosting the warm incremental analyzer, so multiple clients (the LSP,
// `seed serve`, the CLI) share one warm compiler instead of each cold-starting their own. It keeps a per-document
// `IncrementalAnalyzer`, so a re-analyze after an edit re-checks only the definitions that changed. The transport is
// hono over HTTP (the same dependency the dev server uses). See note/seed/plan/compilation-performance.md (Tier 4).

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { IncrementalAnalyzer } from '@cluesurf/flow/code/incremental'
import { projectResolver } from '@cluesurf/call/code/make'
import { findProjectRoot } from '@cluesurf/call/code/boot'
import type { NativeEnv } from '@cluesurf/make/code/compile/native'

export interface Daemon {
  port: number
  // number of warm documents (for diagnostics / tests)
  warm(): number
  close(): void
}

// start the daemon. `POST /analyze {file, text}` returns that document's diagnostics (incrementally re-checked).
// `GET /health` reports liveness + how many documents are warm.
export function startDaemon(options: {
  root: string
  port?: number
  env?: NativeEnv
}): Daemon {
  const projectRoot = findProjectRoot(options.root)
  const resolve = projectResolver(projectRoot, options.env ?? 'node')
  const port = options.port ?? 5179
  // one warm analyzer per document, kept alive across requests (the whole point of the daemon)
  const analyzers = new Map<string, IncrementalAnalyzer>()

  const analyzerFor = (file: string): IncrementalAnalyzer => {
    let analyzer = analyzers.get(file)
    if (!analyzer) {
      analyzer = new IncrementalAnalyzer(resolve)
      analyzers.set(file, analyzer)
    }
    return analyzer
  }

  const app = new Hono()

  app.get('/health', context =>
    context.json({ ok: true, warm: analyzers.size }),
  )

  app.post('/analyze', async context => {
    const body = (await context.req.json()) as {
      file?: string
      text?: string
    }
    if (typeof body.file !== 'string' || typeof body.text !== 'string')
      return context.json({ error: 'file and text required' }, 400)
    const result = await analyzerFor(body.file).analyze({
      file: body.file,
      text: body.text,
    })
    return context.json({ diagnostics: result.diagnostics })
  })

  // drop a document's warm state (the editor closed it)
  app.post('/close', async context => {
    const body = (await context.req.json()) as { file?: string }
    if (typeof body.file === 'string') analyzers.delete(body.file)
    return context.json({ ok: true })
  })

  const server = serve({ fetch: app.fetch, port })
  return {
    port,
    warm: () => analyzers.size,
    close: () => server.close(),
  }
}
