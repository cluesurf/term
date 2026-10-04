// `term feed [entry]`: the dev server. Compiles the app in per-module mode, serves each module lazily over native
// ESM, and hot-reloads on change over SSE (it "feeds" live updates to the browser). The entry is an argument or the
// `deck.tree` boot entry. Stays alive until interrupted. See code/dev/server.ts.
//
// A SERVICE in the terminal output standard's sense (section 11): a `start` item with its address, a `reload` item
// per hot-applied file, and on ctrl-c the closing `Stopped` item with the uptime, exit 130.

import { realpathSync, watch as fsWatch, existsSync } from 'fs'
import path from 'path'
import { startDevServer } from '@term/call/code/dev/server'
import { findEntry } from '@term/call/code/boot'
import type { NativeEnv } from '@term/make/code/compile/native'
import { closeRun, failRun, field, openRun, report, showPath } from '@term/call/code/output'

export async function callFeed(input: {
  root: string
  entry?: string
  port?: number
  env?: NativeEnv
}): Promise<void> {
  openRun({ verb: 'feed', root: input.root })

  try {
    const entry = findEntry(input.root, input.entry)

    if (!entry || !existsSync(entry)) {
      report({
        glyph: 'failed',
        kind: 'problem',
        subject: entry ? 'The entry file does not exist' : 'There is no entry: none was given and deck.tree has no `boot <path>`',
        fields: entry ? [field('at', showPath(entry, input.root))] : [],
      })
      // an entry the command line or the manifest owed: wrong usage, exit 2, as `term boot` ends on the same miss
      closeRun({ verdict: 'Not started', failure: 'usage' })

      return
    }

    const started = Date.now()
    const port = input.port ?? 5173
    const server = startDevServer({
      root: input.root,
      entry,
      port,
      env: input.env ?? 'browser',
    })

    // watch the project for `.tree` edits and hot-apply each change
    let timer: ReturnType<typeof setTimeout> | undefined

    const pending = new Set<string>()
    const watcher = fsWatch(
      input.root,
      { recursive: true },
      (_event, name) => {
        const file = typeof name === 'string' ? name : ''

        if (!file.endsWith('.tree')) {
          return
        }

        if (file.includes('/.base/@cluesurf/term/') || file.includes('/host/')) {
          return
        }

        const full = path.join(input.root, file)

        if (!existsSync(full)) {
          return
        }

        pending.add(realpathSync(full))

        if (timer) {
          clearTimeout(timer)
        }

        timer = setTimeout(() => {
          for (const changed of pending) {
            const begun = Date.now()
            const result = server.update(changed)
            report({
              glyph: 'info',
              kind: 'lifecycle',
              verb: 'reload',
              subject: `${showPath(changed, input.root)} changed`,
              duration: Date.now() - begun,
              facts: [result.type],
            })
          }

          pending.clear()
        }, 30)
      },
    )

    report({ glyph: 'done', kind: 'lifecycle', verb: 'start', subject: `http://localhost:${port}`, duration: Date.now() - started, facts: ['hot reload'] })

    // stay alive until interrupted, then clean up and close the run
    process.on('SIGINT', () => {
      watcher.close()
      server.close()
      process.exit(closeRun({ verdict: 'Stopped', failure: 'interrupted', uptime: true }))
    })
  } catch (err) {
    failRun(err, input.root)
  }
}
