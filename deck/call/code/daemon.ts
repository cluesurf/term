// `seed daemon`: run the long-lived compiler daemon. It hosts the warm incremental analyzer over HTTP, so the LSP,
// `seed serve`, and CLI share one warm compiler instead of each cold-starting. Stays alive until interrupted.
// See code/dev/daemon.ts and note/seed/plan/compilation-performance.md (Tier 4).

import { startDaemon } from '@cluesurf/make/code/dev/daemon'
import type { NativeEnv } from '@cluesurf/make/code/compile/native'
import {
  logStep,
  logGood,
  logFail,
  formatError,
  fade,
} from '@cluesurf/make/code/tint'

export async function callDaemon(input: {
  root: string
  port?: number
  env?: NativeEnv
}): Promise<void> {
  logStep('Starting compiler daemon...')
  try {
    const port = input.port ?? 5179
    const daemon = startDaemon({
      root: input.root,
      port,
      env: input.env ?? 'node',
    })
    logGood(`compiler daemon on http://localhost:${port}`)
    console.log(
      fade(
        '  POST /analyze {file, text} -> diagnostics. ctrl-c to stop.',
      ),
    )
    process.on('SIGINT', () => {
      daemon.close()
      process.exit(0)
    })
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
