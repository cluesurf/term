// `seed serve [entry]`: the dev server. Compiles the app in per-module mode, serves each module lazily over native
// ESM, and hot-reloads on change over SSE. The entry is an argument or the `deck.tree` boot entry. Stays alive until
// interrupted. See code/dev/server.ts and note/seed/plan/compilation-performance.md (Tier 3).

import { realpathSync, watch as fsWatch, existsSync } from 'fs'
import path from 'path'
import { startDevServer } from '../dev/server'
import { findEntry } from './boot'
import type { NativeEnv } from '../compile/native'
import { logStep, logGood, logFail, formatError, fade } from '../tint'

export async function callServe(input: {
  root: string
  entry?: string
  port?: number
  env?: NativeEnv
}): Promise<void> {
  logStep('Starting dev server...')
  try {
    const entry = findEntry(input.root, input.entry)
    if (!entry || !existsSync(entry)) {
      logFail(
        entry
          ? `Entry not found: ${entry}`
          : 'No entry given and no `boot <path>` in deck.tree',
      )
      process.exit(1)
    }

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
        if (!file.endsWith('.tree')) return
        if (file.includes('/.seed/') || file.includes('/host/')) return
        const full = path.join(input.root, file)
        if (!existsSync(full)) return
        pending.add(realpathSync(full))
        if (timer) clearTimeout(timer)
        timer = setTimeout(() => {
          for (const changed of pending) {
            const result = server.update(changed)
            console.log(
              fade(`  ${path.basename(changed)} -> ${result.type}`),
            )
          }
          pending.clear()
        }, 30)
      },
    )

    logGood(`dev server on http://localhost:${port}`)
    console.log(fade('  editing a .tree file hot-reloads. ctrl-c to stop.'))

    // stay alive until interrupted, then clean up
    process.on('SIGINT', () => {
      watcher.close()
      server.close()
      process.exit(0)
    })
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
