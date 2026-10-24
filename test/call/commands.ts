// Write note/project/term/commands.md: every `term` verb, its subcommands, and its options.
//
// GENERATED, from two sources, each used for what it is authoritative about:
//
//   STRUCTURE from `term --help` and `term <verb> --help`. Which verbs exist and which subcommands hang off them is
//   the CLI's own answer, so the page cannot describe a verb that does not exist or miss one that does.
//   TEXT from the console's ROUTES (deck/call/code/line/base.tree, read through commandRoutes as term:cli-drift reads
//   it): each hook's note is its command's sentence, each take's note its option's. Help HARD-WRAPS at 80 columns,
//   breaking mid-word ('the veri' / 'fier') and at spaces ('(--audit' / 'for the') indistinguishably, so a description
//   rejoined from the printed output is corrupted either way. The note is the whole sentence. Until 0193 the text
//   came from line.ts's `.command` and `.option` literals, which the console replaces (decision cli-in-term/013).
//
// So the page reads the same from host/line.js and from the console (TERM_LINE, test/call/cli.ts).
//
// Neither is hand-written, which is the point: a hand-kept command reference is wrong the first time somebody adds a
// flag, and wrong silently.
//
// It REPORTS by default and WRITES only on --commit, the house rule. As a gate it runs without --commit and fails
// when the page on disk no longer matches the CLI, which is the whole point.
//
// Run: npx tsx test/call/commands.ts             (check: is the page current)
//      npx tsx test/call/commands.ts --commit    (write it)

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import type { DockRoute } from '@term/make/code/compile/node'
import { commandRoutes, programOf } from '@term/call/code/work/hook/parsing'
import { projectResolver } from '@term/call/code/make'
import { projectLeanOf, projectRoleOf } from '@term/call/code/role-of'
import { LINE } from './cli'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const PAGE = join(TERM, '../../../../note/project/term/commands.md')
const CONSOLE = join(TERM, 'deck/call/code/line/base.tree')

// the console's routes, as `term make` reads the file: its program (the global options) and its commands
function consoleRoutes(): { program?: DockRoute; commands: DockRoute[] } {
  const result = compile(
    { file: CONSOLE, text: readFileSync(CONSOLE, 'utf8') },
    { resolve: projectResolver(TERM), roleOf: projectRoleOf(TERM), leanOf: projectLeanOf(TERM) },
  )

  if (!result.ok) {
    throw new Error(`deck/call/code/line/base.tree does not compile: ${result.diagnostics.slice(0, 3).map(d => d.message).join('; ')}`)
  }

  // the port answers the program as a maybe (work/hook/parsing.tree `console-program`)
  const split = programOf(commandRoutes(result.program))

  return split.program.form === 'some' ? { program: split.program.value, commands: split.commands } : { commands: split.commands }
}

const ROUTES = consoleRoutes()

function help(argv: string[]): string {
  try {
    return execFileSync('node', [LINE, ...argv, '--help'], {
      cwd: TERM,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30000,
    })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string }

    return `${e.stdout ?? ''}${e.stderr ?? ''}`
  }
}

// yargs prints `  term <verb> [args]   <description>`, with at least two spaces between the signature and the
// description, and wraps a long description onto continuation lines indented to the description column. The
// signature can carry positionals (`wake [name]`, `scan <file>`), which belong with the verb rather than at the
// front of its description.
type Command = { name: string; args: string; note: string }

function commands(text: string, prefix: string): Command[] {
  const out: Command[] = []
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === 'Commands:')

  if (start === -1) {
    return out
  }

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break
    }

    const entry = new RegExp(`^\\s+${prefix}\\s+(\\S+)((?:\\s+[<\\[]\\S*)*)\\s{2,}(.*)$`).exec(line)

    if (entry) {
      out.push({
        name: entry[1]!,
        args: entry[2]!.trim(),
        note: entry[3]!.trim().replace(/\s+/g, ' '),
      })
      continue
    }

    // a continuation of the previous description. yargs breaks mid-word, so the pieces are joined without a space
    // and the result is re-wrapped by whatever renders the page.
    const last = out[out.length - 1]

    if (last && /^\s{20,}\S/.test(line)) {
      last.note = `${last.note}${line.trim()}`
    }
  }

  return out
}

// yargs prints an Options: block; the global ones repeat on every verb and are listed once at the end instead
const GLOBAL = new Set(['--help', '--version', '-h', '-v'])

function options(text: string, verb: string): string[] {
  const out: string[] = []
  const lines = text.split('\n')
  const start = lines.findIndex(line => line.trim() === 'Options:')

  if (start === -1) {
    return out
  }

  for (const line of lines.slice(start + 1)) {
    if (line.trim() === '') {
      break
    }

    const flag = /^\s+(-[^\s,]+(?:,\s*--[^\s,]+)?)\s{2,}(.*)$/.exec(line)

    if (flag && !GLOBAL.has(flag[1]!.split(',')[0]!.trim())) {
      const flags = flag[1]!.trim()
      const long = /--([\w-]+)/.exec(flags)?.[1]
      const note =
        (long ? (OPTION_NOTE.get(`${verb}|${long}`) ?? OPTION_NOTE.get(`*|${long}`)) : undefined) ??
        flag[2]!.trim().replace(/\s+/g, ' ')

      out.push(`\`${flags}\` ${note}`)
    }
  }

  return out
}

// the complete description of every command, keyed by its path (`make`, `self find`), from its hook's note
function notes(): Map<string, string> {
  const out = new Map<string, string>()
  const walk = (route: DockRoute, parent?: string): void => {
    const path = parent ? `${parent} ${route.path}` : route.path

    if (route.note) {
      out.set(path, route.note.trim())
    }

    for (const kid of route.children ?? []) {
      walk(kid, path)
    }
  }

  for (const route of ROUTES.commands) {
    walk(route)
  }

  return out
}

const NOTE = notes()

// option descriptions, from each take's note, for the same reason: help truncates them.
//
// Keyed by VERB AND OPTION, never by option alone. Two verbs define `--trees` with entirely different meanings
// ("compile .tree even when package.json owns make" on `make`, "keep tree anchors instead of expanding them" on
// `mold`), and a global key silently documented one with the other's sentence. A wrong description is worse than a
// truncated one, because nothing about it looks wrong. A take is keyed by its name and by each of its other names
// (`--ride` and `--watch`). The program's takes, the global options every verb prints, are keyed under `*`.
function optionNotes(): Map<string, string> {
  const out = new Map<string, string>()
  const add = (owner: string, route: DockRoute): void => {
    for (const take of route.takes) {
      if (take.note) {
        for (const name of [take.name, ...(take.aliases ?? [])]) {
          out.set(`${owner}|${name}`, take.note.trim())
        }
      }
    }
  }

  if (ROUTES.program) {
    add('*', ROUTES.program)
  }

  for (const route of ROUTES.commands) {
    add(route.path, route)
  }

  return out
}

// the written description for a command (its path: `make`, `self find`), falling back to what help printed when its
// hook has no note
function noteFor(command: Command, parent?: string): string {
  return NOTE.get(parent ? `${parent} ${command.name}` : command.name) ?? command.note
}

const root = help([])
const verbs = commands(root, 'term')
const OPTION_NOTE = optionNotes()

// verbs whose options the page does not list, each because the two CLIs answer its --help differently by decision:
// the shipped CLI answers `term fill --help` with the completion script (a yargs quirk), the console with fill's help
// page (decision cli-in-term/011). fill has no option of its own, so the page loses nothing and reads the same from both
const OWN_HELP_ONLY = new Set(['fill'])

const body: string[] = [
  '# Commands',
  '',
  '**Generated. Do not edit.** Run `npx tsx test/call/commands.ts --commit` from',
  '`deck/term/deck/term` after changing the CLI. `pnpm term:test` fails when this',
  'page and the CLI disagree.',
  '',
  'Built by running `term --help` and `term <verb> --help`, so it describes the',
  'commands that exist rather than the ones somebody remembered to write down.',
  '',
  `${verbs.length} verbs.`,
  '',
  '| verb | what |',
  '| --- | --- |',
  ...verbs.map(v => `| [\`${v.name}\`](#${v.name}) | ${v.args ? `\`${v.args}\` ` : ''}${noteFor(v)} |`),
  '',
]

for (const verb of verbs) {
  const text = help([verb.name])
  const subs = commands(text, `term ${verb.name}`)
  const flags = OWN_HELP_ONLY.has(verb.name) ? [] : options(text, verb.name)

  body.push(`## ${verb.name}`, '', `\`term ${verb.name}${verb.args ? ` ${verb.args}` : ''}\``, '', noteFor(verb), '')

  if (subs.length > 0) {
    body.push('| subcommand | what |', '| --- | --- |')
    body.push(...subs.map(s => `| \`${s.name}${s.args ? ` ${s.args}` : ''}\` | ${noteFor(s, verb.name)} |`))
    body.push('')
  }

  if (flags.length > 0) {
    body.push(...flags.map(f => `- ${f}`), '')
  }
}

body.push(
  '## Every verb answers bad input in words',
  '',
  '`test/call/bad-input.ts` feeds each verb a bad flag and a bad path from an empty',
  'directory and fails on a stack trace, a raw runtime error class, or a bare errno',
  'reaching the output. A verb is free to fail, and most of these should. It has to',
  'fail in a sentence.',
  '',
)

const page = body.join('\n')
const current = existsSync(PAGE) ? readFileSync(PAGE, 'utf8') : ''
const same = current === page
const commit = process.argv.includes('--commit')

if (commit) {
  writeFileSync(PAGE, page)
  console.log(`wrote note/project/term/commands.md (${verbs.length} verbs)`)
} else if (!same) {
  console.log(
    'note/project/term/commands.md is out of date. Run `npx tsx test/call/commands.ts --commit` from deck/term/deck/term',
  )
}

console.log(`\ncommands: ${same || commit ? 1 : 0} pass, ${same || commit ? 0 : 1} fail`)

if (!same && !commit) {
  process.exit(1)
}
