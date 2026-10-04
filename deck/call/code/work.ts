// `term work`: run the long-lived compiler daemon (the background worker). It hosts the warm incremental analyzer over
// HTTP, so the LSP, `term feed`, and the CLI share one warm compiler instead of each cold-starting. Stays alive until
// interrupted. See code/dev/daemon.ts. Prints as a service (section 11 of note/term/output/standard.md): a `start`
// item with its address, then a `Stopped` closing item with its uptime on ctrl-c.

import { startDaemon } from '@term/call/code/dev/daemon'
import type { NativeEnv } from '@term/make/code/compile/native'
import { closeRun, field, openRun, report } from '@term/call/code/output'

export async function callWork(input: {
  root: string
  port?: number
  env?: NativeEnv
}): Promise<void> {
  const env = input.env ?? 'node'
  openRun({ verb: 'work', root: input.root, facts: [env] })
  const started = Date.now()

  try {
    const port = input.port ?? 5179
    const daemon = startDaemon({
      root: input.root,
      port,
      env,
    })

    report({
      glyph: 'done',
      kind: 'lifecycle',
      verb: 'start',
      subject: `http://localhost:${port}`,
      duration: Date.now() - started,
      fields: [field('route', 'POST /analyze {file, text}, answers diagnostics')],
    })
    process.on('SIGINT', () => {
      daemon.close()
      // Ctrl-C: ○ and exit 130 (section 18), as `term boot` and `term feed` end
      process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true }))
    })
  } catch (err) {
    report({ glyph: 'failed', kind: 'lifecycle', verb: 'start', subject: 'The compiler worker did not start', message: [err instanceof Error ? err.message : String(err)] })
    closeRun({ verdict: 'Not started' })
  }
}
