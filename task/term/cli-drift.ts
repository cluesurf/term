// The CLI conversion gate: does the command tree written in Term describe the CLI that actually ships?
//
// `cli-in-term` replaces `deck/call/code/line.ts`, 1,251 lines of yargs, with a `hook` command tree in Term
// (`deck/call/code/line/base.tree`), the way `deck/zone/code/line/base.tree` already does for the zone console. The
// only safe way to rewrite 33 commands by hand is to hold the rewrite against what ships, command by command and
// flag by flag, for as long as the conversion takes.
//
// THE SHIPPED SIDE IS THE HELP OUTPUT, on purpose. `term <verb> --help` is the contract a person reads, so it is
// the thing that must not change. Reading the yargs source instead would compare the rewrite against someone's
// reading of the old code rather than against the CLI.
//
// THE TERM SIDE GOES THROUGH THE MILL, never a regex. A top-level `hook` lowers to a `DockRoute` and
// `commandRoutes` reads them out, which is the same path the dispatcher takes at run time, so the gate cannot agree
// with a tree the dispatcher would read differently.
//
// Until the tree exists this reports the whole surface as unwritten, which makes it the conversion's progress meter
// as well as its gate: `33 commands to write` counts down.
//
// A take the route has can still be DROPPED: a wrapper task that takes it and passes it nowhere (line/base.tree
// make-project read 23 takes and called its verb with 5). So the gate also counts dropped takes, through the
// compiler's own read sites (task/term/take-reach.ts, decision cli-in-term/013 part 2): one `dropped:` line each, and
// any drop fails the gate as a drift does.
//
// Run from the repository root: `pnpm term:cli-drift`. Reports by default and writes nothing.
// Design: note/project/term/cli-in-term/readme.md.

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { dropLine, dropsOf, readConsole, type Console } from './take-reach'
import { TERM_ROOT } from './root'

// run from the Term root, the way every other term task is
const TERM = TERM_ROOT
const CLI = join(TERM, 'host/line.js')
const TREE = join(TERM, 'deck/call/code/line/base.tree')

const verbose = process.argv.includes('--verbose')

// the four yargs adds to every command. They are the framework's, not the CLI's surface, so neither side owes them.
const UNIVERSAL = new Set(['help', 'hint', 'back', 'version'])

// the GLOBAL output flags of the terminal output standard (note/project/term/output/readme.md), on every command and read
// once by line.ts's middleware into code/output.ts. They are no command's own surface: the Term tree declares
// parameters per hook, in the order its task takes them, and has no way yet to declare one flag for every command
// (note/project/term/research/cli-hook-dsl-gaps.md, "global flags"). Until it does, neither side owes them per command
const GLOBAL_OUTPUT = new Set(['quiet', 'verbose', 'trace', 'log', 'color', 'utc', 'plain', 'strict', 'motion', 'yes', 'raw', 'source'])

// the global flags a command may also declare for itself, each with a phrase from the global's own description
const GLOBAL_SHARED: Record<string, string> = { all: 'Show every problem and list entry past the cap' }

// Commands whose parameters cannot be read from their help, each with the reason. A NAMED EXCEPTION, not a hole:
// the list is short, it is checked, and a command that stops needing its exception shows up as one that is in the
// tree and not in the CLI.
const OPAQUE: Record<string, string> = {
  zone: 'it forwards its whole argv to the zone console and turns its own `--help` off (`.help(false)`), so yargs prints no parameters to compare against',
  mark: 'it forwards its whole argv to the benchmark runner (deck/mark/code/line.tree) and turns its own `--help` off, so the help printed is the runner\'s `run` hook, not this command',
}

type Flag = { name: string; short?: string; type?: string }
type Command = { name: string; flags: Map<string, Flag> }

function ask(args: string[]): string {
  try {
    return execFileSync('node', [CLI, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (cause) {
    // yargs exits non-zero on some help paths; its output is still on stdout
    const out = (cause as { stdout?: string }).stdout

    return out ?? ''
  }
}

// every verb `term --help` lists, and every subcommand each of those lists in turn
function shippedCommands(): string[] {
  const top = [
    ...new Set(
      [...ask(['--help']).matchAll(/^ {2,}(?:term|seed) ([a-z][a-z-]*)/gm)].map(
        m => m[1] as string,
      ),
    ),
  ]

  const all: string[] = []

  for (const verb of top) {
    all.push(verb)

    if (OPAQUE[verb]) {
      continue
    }

    // `Commands:` lists a verb's subcommands as `  term base init  ...`
    const help = ask([verb, '--help'])
    const block = /\nCommands:\n([\s\S]*?)(?:\n\s*\n|$)/.exec(help)?.[1] ?? ''

    for (const found of block.matchAll(
      new RegExp(`^ {2,}(?:term|seed) ${verb} ([a-z][a-z-]*)`, 'gm'),
    )) {
      all.push(`${verb} ${found[1] as string}`)
    }
  }

  return [...new Set(all)].sort()
}

// One verb's whole parameter surface, from its own help: the `Positionals:` block AND the `Options:` block.
//
// BOTH BLOCKS, because the Term side does not distinguish them. yargs writes a positional as `save [deck]` and
// prints it under `Positionals:`, while a `hook` writes it as an ordinary `take` and the dispatcher fills it from
// position. Reading only the options block reported every positional as "in the tree and not in the CLI", which is
// 17 of the first 19 differences this gate found and none of them real.
function shippedFlags(command: string[]): Map<string, Flag> {
  const text = ask([...command, '--help'])
  const flags = new Map<string, Flag>()

  // `Positionals:` up to the blank line before `Options:`
  const positionals = /\nPositionals:\n([\s\S]*?)\n\s*\n/.exec(text)?.[1] ?? ''

  for (const line of positionals.split('\n')) {
    const found = /^ {2}([a-z][a-z0-9-]*)\s{2,}/.exec(line)

    if (found) {
      const name = found[1] as string
      flags.set(name, {
        name,
        type: /\[(boolean|string|number|array)\]/.exec(line)?.[1],
      })
    }
  }

  for (const line of text.split('\n')) {
    const found =
      /^ {2,}(?:-([a-zA-Z]), )?--([a-z][a-z0-9-]*)(?:, --[a-z0-9-]+)*\s{2,}/.exec(
        line,
      )

    if (!found) {
      continue
    }

    const name = found[2] as string

    if (UNIVERSAL.has(name) || GLOBAL_OUTPUT.has(name)) {
      continue
    }

    // a global a command may declare again with its own meaning (`look --all`): skipped only where the help line is
    // the global's own, so the command's version is still compared
    if (GLOBAL_SHARED[name] !== undefined && line.includes(GLOBAL_SHARED[name])) {
      continue
    }

    // the type yargs prints at the end of the block, e.g. `[boolean]` / `[string]`
    const type = /\[(boolean|string|number|array|count)\]/.exec(line)?.[1]

    flags.set(name, { name, short: found[1], type })
  }

  return flags
}

// the command tree as the DISPATCHER reads it: through the mill, never a regex. The role and the lean surface, as
// `term make` reads them: the tree's import closure reaches the verbs under deck/call/code/work, which are written
// lean (self-hosting-0015), and read as longhand they do not compile. SUBCOMMANDS TOO (`base` alone has fourteen),
// and the console is one program hook (decision term/003 part 3): its commands are its nested hooks, and its takes
// the global options, which neither side owes per command (take-reach.ts readConsole)
function treeConsole(): Console | undefined | 'broken' {
  if (!existsSync(TREE)) {
    return undefined
  }

  try {
    return readConsole(TREE, TERM)
  } catch (cause) {
    console.log(`  the command tree does not compile: ${(cause as Error).message}`)

    return 'broken'
  }
}

function treeCommands(read: Console): Command[] {
  return read.commands.map(command => ({
    name: command.path,
    flags: new Map(
      command.takes
        .filter(take => !UNIVERSAL.has(take.name))
        .map(take => [take.name, { name: take.name, short: take.short, type: take.type?.kind }]),
    ),
  }))
}

function main(): void {
  const shipped = shippedCommands()
  const read = treeConsole()
  const tree = read === undefined ? undefined : read === 'broken' ? [] : treeCommands(read)

  console.log(
    `term cli-drift: ${shipped.length} commands ship, ${tree === undefined ? 'the Term command tree does not exist yet' : `${tree.length} in the Term tree`}`,
  )

  if (tree === undefined) {
    console.log('')
    console.log(`  write deck/call/code/line/base.tree (cli-in-term-0002).`)
    console.log(
      `  ${shipped.length} commands to write: ${shipped.join(', ')}`,
    )
    console.log('')
    console.log(
      `term cli-drift: ${shipped.length} commands to write, 0 drifted`,
    )

    return
  }

  const byName = new Map(tree.map(c => [c.name, c]))
  let drifted = 0
  const missing: string[] = []

  for (const command of shipped) {
    const built = byName.get(command)

    if (!built) {
      missing.push(command)
      continue
    }

    if (OPAQUE[command]) {
      continue
    }

    const want = shippedFlags(command.split(' '))
    const gaps: string[] = []

    for (const [name, flag] of want) {
      const have = built.flags.get(name)

      if (!have) {
        gaps.push(`--${name} absent`)
        continue
      }

      if (flag.short && have.short !== flag.short) {
        gaps.push(`--${name} short ${flag.short ?? '-'} vs ${have.short ?? '-'}`)
      }
    }

    for (const name of built.flags.keys()) {
      if (!want.has(name)) {
        gaps.push(`--${name} is in the tree and not in the CLI`)
      }
    }

    if (gaps.length > 0) {
      drifted++
      console.log(`  ${command}: ${gaps.length} difference(s)`)

      for (const gap of gaps.slice(0, verbose ? 99 : 6)) {
        console.log(`      ${gap}`)
      }
    }
  }

  const extra = tree.filter(c => !shipped.includes(c.name)).map(c => c.name)

  if (missing.length > 0) {
    console.log(`  not written yet (${missing.length}): ${missing.join(', ')}`)
  }

  if (extra.length > 0) {
    console.log(`  in the tree and not in the CLI: ${extra.join(', ')}`)
  }

  for (const [command, why] of Object.entries(OPAQUE)) {
    console.log(`  not comparable  ${command}: ${why}`)
  }

  // every take of every route, opaque commands included: a passing hook's slot is a take its task must read too
  const drops = read === 'broken' || read === undefined ? [] : dropsOf(read)

  for (const drop of drops) {
    console.log(`  ${dropLine(drop)}`)
  }

  console.log('')
  console.log(
    `term cli-drift: ${missing.length} commands to write, ${drifted + extra.length} drifted, ${drops.length} dropped, ${Object.keys(OPAQUE).length} not comparable`,
  )

  if (drifted + extra.length + drops.length > 0 || read === 'broken') {
    process.exitCode = 1
  }
}

main()
