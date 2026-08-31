// Write note/term/commands.md: every `term` verb, its subcommands, and its options.
//
// GENERATED, from two sources, each used for what it is authoritative about:
//
//   STRUCTURE from `term --help` and `term <verb> --help`. Which verbs exist and which subcommands hang off them is
//   the CLI's own answer, so the page cannot describe a verb that does not exist or miss one that does.
//   TEXT from the `.command('name', 'description')` literals in deck/call/code/line.ts. yargs HARD-WRAPS its help at
//   80 columns and ignores COLUMNS, breaking mid-word ('the veri' / 'fier') and at spaces ('(--audit' / 'for the')
//   indistinguishably, so a description rejoined from the printed output is corrupted either way. The literal is the
//   whole sentence.
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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')
const PAGE = join(TERM, '../../../../note/term/commands.md')

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
        (long ? OPTION_NOTE.get(`${verb}|${long}`) : undefined) ??
        flag[2]!.trim().replace(/\s+/g, ' ')

      out.push(`\`${flags}\` ${note}`)
    }
  }

  return out
}

// the complete description text, from the `.command('signature', 'description')` literals. Keyed by the full
// signature so a subcommand name reused under two verbs (`list`, `show`, `check`) does not collide.
function notes(): Map<string, string> {
  const source = readFileSync(join(TERM, 'deck/call/code/line.ts'), 'utf8')
  const out = new Map<string, string>()

  for (const match of source.matchAll(
    /\.command\(\s*(['"])([^'"]+)\1\s*,\s*(['"])([^'"]*)\3/gs,
  )) {
    out.set(match[2]!.trim().replace(/\s+/g, ' '), match[4]!.trim())
  }

  return out
}

const NOTE = notes()

// option descriptions, from the `.option('name', { description: '...' })` literals, for the same reason: yargs
// truncates them in the printed help.
//
// Keyed by VERB AND OPTION, never by option alone. Two verbs define `--trees` with entirely different meanings
// ("compile .tree even when package.json owns make" on `make`, "keep tree anchors instead of expanding them" on
// `mold`), and a global key silently documented one with the other's sentence. A wrong description is worse than a
// truncated one, because nothing about it looks wrong.
//
// Each `.option(` belongs to the builder of the nearest `.command('<verb>'` above it, which is how the CLI is
// written, so that is how they are paired.
function optionNotes(verbs: Set<string>): Map<string, string> {
  const source = readFileSync(join(TERM, 'deck/call/code/line.ts'), 'utf8')
  const out = new Map<string, string>()

  // where each verb's builder starts
  const starts: { at: number; verb: string }[] = []

  for (const match of source.matchAll(/\.command\(\s*(['"])([^'"]+)\1/g)) {
    const verb = match[2]!.trim().split(/\s+/)[0]!

    if (verbs.has(verb)) {
      starts.push({ at: match.index!, verb })
    }
  }

  for (const match of source.matchAll(
    /\.option\(\s*(['"])([^'"]+)\1\s*,\s*\{[\s\S]*?description:\s*(['"])((?:[^'"\\]|\\.)*)\3/g,
  )) {
    let owner: string | undefined

    for (const start of starts) {
      if (start.at < match.index!) {
        owner = start.verb
      } else {
        break
      }
    }

    if (owner) {
      out.set(`${owner}|${match[2]!}`, match[4]!.replace(/\\'/g, "'").trim())
    }
  }

  return out
}


// the written description for a command, falling back to what help printed if the literal cannot be found (a
// command built some other way, or one whose description is a template rather than a literal)
function noteFor(command: Command): string {
  const signature = command.args
    ? `${command.name} ${command.args}`
    : command.name

  return NOTE.get(signature) ?? command.note
}

const root = help([])
const verbs = commands(root, 'term')
const OPTION_NOTE = optionNotes(new Set(verbs.map(v => v.name)))

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
  const flags = options(text, verb.name)

  body.push(`## ${verb.name}`, '', `\`term ${verb.name}${verb.args ? ` ${verb.args}` : ''}\``, '', noteFor(verb), '')

  if (subs.length > 0) {
    body.push('| subcommand | what |', '| --- | --- |')
    body.push(...subs.map(s => `| \`${s.name}${s.args ? ` ${s.args}` : ''}\` | ${noteFor(s)} |`))
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
  console.log(`wrote note/term/commands.md (${verbs.length} verbs)`)
} else if (!same) {
  console.log(
    'note/term/commands.md is out of date. Run `npx tsx test/call/commands.ts --commit` from deck/term/deck/term',
  )
}

console.log(`\ncommands: ${same || commit ? 1 : 0} pass, ${same || commit ? 0 : 1} fail`)

if (!same && !commit) {
  process.exit(1)
}
