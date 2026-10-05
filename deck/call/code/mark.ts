/**
 * `term mark [filter]` -- the benchmark suite. Compares the code Term EMITS with code a person wrote by hand, for the
 * same program on the same input, per target (node, Rust, Swift, Kotlin), with the output checked on every run. Not
 * `term time`, which times zero-argument `time-*` tasks inside one project on node.
 *
 *   term mark                     every program, every installed target
 *   term mark demo --runs 10      the programs whose `<family>/<program>` contains `demo`
 *   term mark list                every program and whether its bench.tree lets it run
 *
 * The runner is a Term program, `deck/mark/code/line.tree` in the Term repository (note/term/bench/rules.md, "The layout").
 * This verb is a thin dispatcher: it finds that directory and boots the runner there, the way `term zone` boots the
 * zone console, passing everything after `mark` through untouched. `term boot` caches the build, so a second run
 * starts at once. The runner's logic stays in `.tree`.
 */

import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { closeRun, field, openRun, report } from '@term/call/code/output'

const MARK_MANIFEST = /^deck @term\/mark$/m

// a directory holding the suite: `deck/mark/deck.tree` declaring `deck @term/mark`. The repository's `mark/` beside
// it holds the benchmark programs, and has no manifest
function isSuite(dir: string): boolean {
  const manifest = join(dir, 'deck.tree')

  return existsSync(manifest) && MARK_MANIFEST.test(readFileSync(manifest, 'utf8'))
}

/**
 * Where the suite is. Checked in order:
 *   - the current directory and every directory above it, as the suite itself or as a Term repository holding it in
 *     `deck/mark/` (it was `mark/` until 2026-10-05), so `term mark` works from anywhere inside a checkout;
 *   - beside this CLI: the bundle is `deck/term/deck/term/host/line.js` and the source
 *     `deck/term/deck/term/deck/call/code/mark.ts`, two different depths.
 */
export function findSuite(root: string): string | undefined {
  let at = resolve(root)

  for (;;) {
    if (isSuite(at)) {
      return at
    }

    if (isSuite(join(at, 'deck', 'mark'))) {
      return join(at, 'deck', 'mark')
    }

    const up = dirname(at)

    if (up === at) {
      break
    }

    at = up
  }

  const here = dirname(fileURLToPath(import.meta.url))

  return [resolve(here, '../deck/mark'), resolve(here, '../../mark')].find(isSuite)
}

/**
 * The runner's own command line from what followed `term mark`. `list` (or `--list`) lists the programs, anything
 * else runs them. A bare word is the filter either way: it binds to the runner's first take, `only`.
 */
export function markArguments(rest: string[]): string[] {
  const listing = rest[0] === 'list' || rest.includes('--list')

  if (listing) {
    return ['list', ...rest.filter((one, index) => one !== '--list' && !(index === 0 && one === 'list'))]
  }

  return ['run', ...(rest[0] === 'run' ? rest.slice(1) : rest)]
}

export async function callMark({ root, argv }: { root: string; argv: string[] }): Promise<void> {
  const suite = findSuite(root)

  if (!suite) {
    // a missing toolchain piece is the environment, exit 3 (section 18)
    openRun({ verb: 'mark', root })
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: 'There is no benchmark suite here',
      message: [
        'It is the deck/mark/ directory of the Term repository (deck/term/deck/term/deck/mark in the cluesurf checkout), and this CLI was not started from inside one or installed from one.',
      ],
      fields: [field('next', 'node <checkout>/deck/term/deck/term/host/line.js mark')],
    })
    process.exit(closeRun({ verdict: 'Nothing benchmarked', failure: 'environment' }))
  }

  // the whole process argument vector from yargs, sliced after `mark`; the ported console (work/tool-verbs.tree)
  // hands over only what followed the verb, which has no `mark` in it
  const at = argv.indexOf('mark')
  const rest = at === -1 ? argv : argv.slice(at + 1)
  const cli = fileURLToPath(new URL(import.meta.url))

  // booted in the suite's directory: `term boot` runs a command-line program in its own cwd, and the runner finds
  // its programs, the compiler and the session directory from there
  const child = spawn(process.execPath, [cli, 'boot', 'code/line.tree', '--', ...markArguments(rest)], {
    cwd: suite,
    stdio: 'inherit',
    env: { ...process.env, TERM_LINE_NAME: 'term mark' },
  })

  await new Promise<void>(done => {
    child.on('exit', (code, signal) => {
      // the runner's exit code passes through: 1 is a refused program, a failed build, a wrong output or a regression
      if (signal) {
        process.kill(process.pid, signal)
      }

      process.exit(code ?? 0)
      done()
    })
  })
}
