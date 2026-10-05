// The term daemon (Tier 4): a long-lived process holding a warm compiler, so several clients (the language server,
// `term feed`, the command line) can share one instead of each cold-starting its own. The transport is hono over HTTP
// (the same dependency the dev server uses). See note/seed/plan/compilation-performance.md (Tier 4).
//
// IT RUNS THE BUILD'S OWN `compile`, with the project's resolver, roles, lean flag and decks, and one compile cache
// for every file it is asked about, the way the language server does (deck/flow/code/server.ts). It ran the
// per-definition `IncrementalAnalyzer` until 2026-10-05, which did not bind names by import or run the `mark private`,
// claim, effect and hold checks, so a file `term make` refused came back clean (guides: commands/work). The cache is
// what keeps a second answer fast: only the module that changed is read again.

import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import * as path from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { CompileCache } from '@term/make/code/compile/cache'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { projectResolver } from '@term/call/code/make'
import { findProjectRoot } from '@term/call/code/boot'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { projectDeckOf } from '@term/call/code/deck-of'
import type { NativeEnv } from '@term/make/code/compile/native'

export interface Daemon {
  port: number
  // number of warm documents (for diagnostics / tests)
  warm(): number
  close(): void
}

// start the daemon. `POST /analyze {file, text}` returns that document's diagnostics, the build's errors or, when it
// builds, its warnings. `GET /health` reports liveness + how many documents are warm.
export function startDaemon(options: {
  root: string
  port?: number
  env?: NativeEnv
}): Daemon {
  const projectRoot = findProjectRoot(options.root)
  const resolve = projectResolver(projectRoot, options.env ?? 'node')
  const roleOf = projectRoleOf(projectRoot)
  const leanOf = projectLeanOf(projectRoot)
  const deckOf = projectDeckOf()
  const port = options.port ?? 5179
  // one compile cache for every document: a second question about a file reads again only what changed
  const cache = new CompileCache()
  // the documents asked about and not closed
  const warm = new Set<string>()

  const app = new Hono()

  app.get('/health', context =>
    context.json({ ok: true, warm: warm.size }),
  )

  app.post('/analyze', async context => {
    const body = await context.req.json()

    if (
      typeof body.file !== 'string' ||
      typeof body.text !== 'string'
    ) {
      return context.json({ error: 'file and text required' }, 400)
    }

    // a file named relative to the project, as a client in it writes one
    const file = path.resolve(projectRoot, body.file)
    warm.add(file)

    const result = compile(
      { file, text: body.text },
      { resolve, cache, roleOf, leanOf, deckOf, optimize: false },
    )
    const diagnostics: Diagnostic[] = result.ok ? result.warnings : result.diagnostics

    return context.json({ diagnostics })
  })

  // drop a document's warm state (the editor closed it)
  app.post('/close', async context => {
    const body = await context.req.json()

    if (typeof body.file === 'string') {
      warm.delete(path.resolve(projectRoot, body.file))
    }

    return context.json({ ok: true })
  })

  const server = serve({ fetch: app.fetch, port })

  return {
    port,
    warm: () => warm.size,
    close: () => server.close(),
  }
}
