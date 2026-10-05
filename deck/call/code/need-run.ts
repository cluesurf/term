// The first module every `term` command starts in, built to `host/need.mjs` (note/term/plan/term-versions.md,
// "Dispatch"). The launcher runs THIS, not the 3.5 MB `host/line.js`, so choosing a version costs one small module.
//
//   1  resolve (need.ts): files and one variable, no network
//   2  the answer is THIS version: import ./line.js in this process, with the `+range` argument removed
//   3  another version: install it if it is not here (./need-hand.mjs, imported only then), then run that version's
//      CLI as a child, same arguments, same directory, inherited stdio, signals forwarded, its exit code ours
//
// THE HANDSHAKE (Go's, `GOTOOLCHAIN_INTERNAL_SWITCH_VERSION`). The child is started with TERM_NEED_SWITCH set to the
// version it must be. A `term` that finds it set does not resolve again: it checks it IS that version and runs, or
// refuses. So a handoff happens at most once per command, and TERM_NEED_DEPTH, counted on every handoff and refused at
// the fourth, is the guard for the case where something outside (a script that calls `term` from inside `term`) keeps
// passing the variables on.
//
// A version older than dispatch (2.6.2, 2.6.4) has no need.mjs. It is started at its line.js, which ignores both.

import { spawn } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import nodePath from 'path'
import { fileURLToPath, pathToFileURL } from 'url'

import { chooseVersion, currentWorld, markUsed, splitFlag } from '@term/call/code/need'
import type * as Hand from '@term/call/code/need-hand'

// the most handoffs one command may make before it is called a loop
const DEPTH_LIMIT = 3

const host = nodePath.dirname(fileURLToPath(import.meta.url))
const running = readRunning()

await main()

async function main(): Promise<void> {
  const env = process.env
  const switchTo = env['TERM_NEED_SWITCH']
  const depth = Number(env['TERM_NEED_DEPTH'] ?? '0') || 0
  const trail = env['TERM_NEED_TRAIL'] ?? ''
  const args = process.argv.slice(2)

  // a child of a handoff: be the version asked for, or nothing
  if (switchTo) {
    if (switchTo !== running) {
      return refuse(`asked to run as term ${switchTo}, and this is ${running}`, args)
    }

    delete env['TERM_NEED_SWITCH']

    return runHere(args)
  }

  // `term self` manages versions, so it runs on the copy that was started, never on a project's: a project pinned to
  // an older release must not take `self` back to that release's verbs. A `+range` before it is for `self show`.
  // `term update` is `term self update` (line.ts), and runs on the front for the same reason
  const own = splitFlag(args)

  if (own.argv[0] === 'self' || own.argv[0] === 'update') {
    if (own.text !== undefined) {
      env['TERM_NEED_FLAG'] = own.text
    }

    return runHere(own.argv)
  }

  const mode = env['TERM_NEED'] ?? 'auto'

  if (mode !== 'auto' && mode !== 'local') {
    return refuse(`TERM_NEED=${mode} is neither auto nor local`, args, true)
  }

  const world = currentWorld({ argv: args, running })
  const { choice, argv } = chooseVersion(world)

  if (choice.form === 'refuse') {
    return refuse(choice.reason, argv, true)
  }

  let version: string

  if (choice.form === 'load') {
    const hand = await loadHand()
    const loaded = await hand.loadNeeded({ choice, running, local: mode === 'local', argv })

    if (!loaded) {
      return
    }

    version = loaded
  } else {
    version = choice.version
  }

  if (version === running) {
    return runHere(argv)
  }

  if (depth >= DEPTH_LIMIT) {
    const seen = [...trail.split(' ').filter(Boolean), running, version].join(', ')

    return refuse(`term handed over ${depth + 1} times without settling (${seen})`, argv)
  }

  markUsed({ home: world.home, version })

  return handOff({
    version,
    entry: entryOf(nodePath.join(world.home, 'code', version, 'term', 'host')),
    argv,
    env: {
      ...env,
      TERM_NEED_SWITCH: version,
      TERM_NEED_DEPTH: String(depth + 1),
      TERM_NEED_TRAIL: [trail, running].filter(Boolean).join(' '),
    },
  })
}

// this version runs the command: the CLI in this process, with the arguments as the command should see them
async function runHere(argv: string[]): Promise<void> {
  const line = nodePath.join(host, 'line.js')

  markUsed({ home: currentWorld({ argv, running }).home, version: running })
  process.argv = [process.argv[0]!, line, ...argv]
  await import(pathToFileURL(line).href)
}

// another version runs it: its own first module, or line.js for a version older than dispatch
function entryOf(dir: string): string {
  const need = nodePath.join(dir, 'need.mjs')

  return existsSync(need) ? need : nodePath.join(dir, 'line.js')
}

// The child, and this process only its shadow: stdio inherited, signals passed on, its exit (or its signal) ours.
// SIGINT from a terminal reaches the whole process group already, so the child gets it once and this process only
// waits; a SIGTERM or SIGHUP sent to this process alone is forwarded
function handOff(input: { version: string; entry: string; argv: string[]; env: NodeJS.ProcessEnv }): Promise<void> {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [input.entry, ...input.argv], { stdio: 'inherit', env: input.env })
    const forward = (signal: NodeJS.Signals) => () => {
      child.kill(signal)
    }
    const handlers: [NodeJS.Signals, () => void][] = [
      ['SIGINT', () => {}],
      ['SIGTERM', forward('SIGTERM')],
      ['SIGHUP', forward('SIGHUP')],
    ]

    for (const [signal, handler] of handlers) {
      process.on(signal, handler)
    }

    child.on('error', error => {
      refuse(`term ${input.version} could not start: ${error.message}`, input.argv)
      resolve()
    })

    child.on('exit', (code, signal) => {
      for (const [name, handler] of handlers) {
        process.off(name, handler)
      }

      if (signal) {
        // die the way the child died, so a shell sees `term` killed by the same signal
        process.kill(process.pid, signal)
      }

      process.exitCode = code ?? 1
      resolve()
    })
  })
}

async function refuse(reason: string, argv: string[], usage = false): Promise<void> {
  const hand = await loadHand()

  // the closing item sets the exit code by the kind of failure, as every command's does
  hand.refuseNeed({ reason, running, usage, argv })
}

function loadHand(): Promise<typeof Hand> {
  return import(pathToFileURL(nodePath.join(host, 'need-hand.mjs')).href) as Promise<typeof Hand>
}

// this payload's version: package.json beside host/
function readRunning(): string {
  try {
    return (JSON.parse(readFileSync(nodePath.join(host, '..', 'package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}
