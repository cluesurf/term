// The term daemon (Tier 4): a long-lived process holding a warm compiler, so several clients (the language server,
// `term feed`, the command line) can share one instead of each cold-starting its own. The transport is hono over HTTP
// (the same dependency the dev server uses). See note/seed/plan/compilation-performance.md (Tier 4).
//
// A FACE OVER ITS PORT, work/serve/compile-daemon.tree, which `term work` runs (work/small/worker-start.tree): one
// build graph for the daemon's life, asked in document mode through build-request with the machine store (decision 077
// section 3 of note/project/term/self-host/change/001-finish-self-host, item term-self-host-001-0414). It ran a
// whole-program `compile` per question with a memory cache until then, and the per-definition `IncrementalAnalyzer`
// until 2026-10-05. Its TypeScript callers (work.ts, test/dev/daemon.ts) keep this API.

import { startDaemon as startDaemonPort } from '@term/call/code/work/serve/compile-daemon'
import type { NativeEnv } from '@term/make/code/compile/native'

export type Daemon = {
  port: number
  // number of warm documents (for diagnostics / tests)
  warm(): number
  close(): void
}

// start the daemon. `POST /analyze {file, text}` returns that document's diagnostics, the build's errors or, when it
// builds, its own warnings. `POST /close {file}` drops the document's warm state and its unsaved text. `GET /health`
// reports liveness + how many documents are warm.
export function startDaemon(options: {
  root: string
  port?: number
  env?: NativeEnv
}): Daemon {
  return startDaemonPort(options) as Daemon
}
