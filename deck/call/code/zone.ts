/**
 * `term zone ...` -- the whole zone console, under the one command.
 *
 *   term zone load -- pnpm boot
 *   term zone load word.surf/moon -- pnpm boot
 *   term zone save some-key
 *   term zone read
 *
 * The console itself is a Term program (`code/line/base.tree` in the zone
 * package), so this finds it and boots it, passing everything after `zone`
 * through untouched.
 *
 * UNTOUCHED MATTERS. A zone invocation carries a `--` separating the zone
 * path from the command to run, plus flags that mean something to the zone
 * console and nothing here. Re-parsing them would swallow the wrong ones, so
 * the argument vector is sliced at `zone` and handed over whole.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Where the zone console lives.
 *
 * Checked in order: beside this CLI in the monorepo, then as an installed
 * dependency. A published CLI does not carry the zone package, so an install
 * that wants `term zone` installs `@cluesurf/zone` alongside it.
 */
function findConsole(root: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))

  const candidates = [
    // the bundled CLI sits at host/line.js, so the package root is one up
    resolve(here, '../deck/zone/code/line/base.tree'),
    resolve(here, '../../deck/zone/code/line/base.tree'),
    join(root, 'node_modules/@cluesurf/zone/code/line/base.tree'),
    join(root, 'node_modules/@term/zone/code/line/base.tree'),
  ]

  return candidates.find(one => existsSync(one))
}

export async function callZone({
  root,
  argv,
}: {
  root: string
  argv: string[]
}): Promise<void> {
  const entry = findConsole(root)

  if (!entry) {
    process.stderr.write(
      'term zone: cannot find the zone console.\n\n' +
        'It ships as its own package, so that a CLI install that does not\n' +
        'use zone does not carry it. Install it with:\n\n' +
        '  pnpm add @cluesurf/zone\n',
    )
    process.exit(1)
  }

  // everything after the `zone` verb, exactly as typed
  const at = argv.indexOf('zone')
  const rest = at === -1 ? [] : argv.slice(at + 1)

  const cli = fileURLToPath(new URL(import.meta.url))

  const child = spawn(
    process.execPath,
    [cli, 'boot', entry, '--', ...rest],
    {
      stdio: 'inherit',
      // The console names itself in its own usage. Run this way it is a
      // subcommand, so it should say `term zone read`, not `zone read`.
      env: { ...process.env, TERM_LINE_NAME: 'term zone' },
    },
  )

  await new Promise<void>(done => {
    child.on('exit', (code, signal) => {
      // the child's exit code passes through: a command run under `zone load`
      // that failed must fail here too, or a script cannot tell.
      if (signal) {
        process.kill(process.pid, signal)
      }

      process.exit(code ?? 0)
      done()
    })
  })
}
