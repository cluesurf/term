/**
 * `term zone ...` -- the zone console, reached through the Term CLI. KEPT AS A
 * FORWARDER: the command is `zone` now.
 *
 *   term zone load -- pnpm boot      is      zone load -- pnpm boot
 *
 * Zone moved out of the Term tree to `deck/zone` on 2026-10-02 and keeps its
 * name, `@term/zone`. It ships through the Term registry, and its own `bin/zone`
 * runs it. This verb stays until every caller has moved, because the API
 * container still starts with `term zone load` from a published
 * `@cluesurf/term` that carries zone inside it. It prints one line naming the
 * replacement, on stderr, so a script's stdout is untouched.
 *
 * The console is a Term program (`code/line/base.tree` in the zone package),
 * so this finds it and boots it, passing everything after `zone` through.
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
 * Checked in order:
 *   - this repository, where zone sits at `deck/zone` beside `deck/term`. The
 *     bundled CLI is `deck/term/deck/term/host/line.js`, and the source is
 *     `deck/term/deck/term/deck/call/code/`, two different depths.
 *   - a project that installed it with `term load`, under `link/@term/zone`.
 *   - a published `@cluesurf/term` from before the move, which carries zone in
 *     its own `deck/zone`. That is what the API container runs today.
 */
function findConsole(root: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url))

  const candidates = [
    resolve(here, '../../../../zone/code/line/base.tree'),
    resolve(here, '../../../../../../zone/code/line/base.tree'),
    join(root, 'link/@term/zone/code/line/base.tree'),
    resolve(here, '../deck/zone/code/line/base.tree'),
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
        'Zone is its own package, `@term/zone`, and its command is `zone`.\n' +
        'It is not beside this CLI and not linked into this project. Run its\n' +
        '`bin/zone` from a checkout, or link it with `term link @term/zone`.\n',
    )
    process.exit(1)
  }

  process.stderr.write('term zone: the command is `zone` now. This forwards for the callers that have not moved.\n')

  // everything after the `zone` verb, exactly as typed
  const at = argv.indexOf('zone')
  const rest = at === -1 ? [] : argv.slice(at + 1)

  const cli = fileURLToPath(new URL(import.meta.url))

  const child = spawn(
    process.execPath,
    [cli, 'boot', entry, '--', ...rest],
    {
      stdio: 'inherit',
      // the console's usage lines name the command people should type, so they
      // say `zone read`, never `term zone read`
      env: { ...process.env, TERM_LINE_NAME: 'zone' },
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
