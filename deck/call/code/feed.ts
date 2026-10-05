// `term feed [entry]`: the dev server. Compiles the app in per-module mode, serves each module lazily over native
// ESM, and hot-reloads on change over SSE (it "feeds" live updates to the browser). The entry is an argument or the
// `deck.tree` boot entry. Stays alive until interrupted. See code/dev/server.ts.
//
// A SERVICE in the terminal output standard's sense (section 11): a `start` item with its address, a `reload` item
// per hot-applied file, and on ctrl-c the closing `Stopped` item with the uptime, exit 130.

import { realpathSync, readFileSync, watch as fsWatch, existsSync } from 'fs'
import path from 'path'
import { startDevServer } from '@term/call/code/dev/server'
import { findEntry, portIsFree } from '@term/call/code/boot'
import type { NativeEnv } from '@term/make/code/compile/native'
import { closeRun, failRun, field, openRun, report, showPath } from '@term/call/code/output'
import { readTree } from '@term/deck/code/read'

export async function callFeed(input: {
  root: string
  entry?: string
  port?: number
  env?: NativeEnv
}): Promise<void> {
  openRun({ verb: 'feed', root: input.root })

  // ctrl-c is answered from the opening item on, the port checks and the cold build included: the handler was added
  // after `start`, so an interrupt during the first compile met node's default, exit 130 and no closing item (guides:
  // commands/feed, 2026-10-05), and set after the port checks it still missed one sent as the opening printed. The
  // build is synchronous, so node holds the signal until it returns, then this closes the run
  let close: (() => void) | undefined

  process.on('SIGINT', () => {
    close?.()
    process.exit(closeRun({ verdict: close ? 'Stopped' : 'Not started', failure: 'interrupted', uptime: close !== undefined }))
  })

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

    // the port is checked, as `term boot`'s is: one named with `-p` that is taken is refused, and without `-p` the first
    // free one from 5173 is used. It was taken as given, and the server failed on it later (guides: commands/feed)
    let port = input.port ?? 5173

    if (input.port !== undefined && !(await portIsFree(input.port))) {
      report({ glyph: 'failed', kind: 'problem', subject: `Port ${input.port} is in use`, fields: [field('next', `term halt -p ${input.port}, or term feed -p <another port>`)] })
      closeRun({ verdict: 'Not started', failure: 'environment' })

      return
    }

    while (input.port === undefined && !(await portIsFree(port)) && port < 5273) {
      port++
    }

    // a page entry with a `boot` task that nothing calls: the shell calls it once the module loads, so the scaffold's
    // `log` runs. A `hook` table boots itself. Nothing called it, and `term wake`'s program logged nothing
    // Read by the parser, never a pattern (note/term/one-parser.md). A file that does not parse calls nothing here, and
    // the build says why
    const read = readTree({ file: entry, text: readFileSync(entry, 'utf8') })
    const forms = read.ok ? read.forms : []
    const definesBoot = forms.some(form => form.head === 'task' && (form.terms[0] ?? form.forms[0]?.head) === 'boot')
    const callsBoot = definesBoot && !forms.some(form => form.head === 'hook')

    const server = startDevServer({
      root: input.root,
      entry,
      port,
      env: input.env ?? 'browser',
      boot: callsBoot,
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

    // stay alive until interrupted, then clean up and close the run (the handler above)
    close = () => {
      watcher.close()
      server.close()
    }
  } catch (err) {
    failRun(err, input.root)
  }
}
