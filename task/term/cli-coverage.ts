// Which `term` verbs and which of their TAKES have a test, and which have none.
//
// WHY THIS EXISTS. The CLI is the only surface most people ever touch, and `pnpm term:test` covers it almost by
// accident. Counting it is the first item of the term-cli project, and a count that has to be re-derived by hand is a
// count nobody re-derives, so this is the check rather than a note.
//
// TAKES, NOT ONLY VERBS (decision cli-in-term/013 part 2). `38 of 38 verbs` was true on 2026-10-23 and said nothing
// about the 18 flags `term make` dropped in silence. The surface is every take of every command, read from the
// console's ROUTES (task/term/take-reach.ts --routes, the routes cli-drift and the dispatcher read), never from line.ts's
// COMMANDS text. A (command, take) is covered by
//   - a verb-pair row that passes it, hand (task/term/verb-pair.txt) or generated (the routes and
//     task/term/verb-pair-flags.txt), read as the dispatcher reads a line (verb-pair.ts takesPassed), or
//   - a command line in a file under test/call (one argument list or array, or one `term ...` literal) holding the
//     command's whole path and, after it, the flag (`'--emit'`, `--emit=`): commandLines and passesFlag below.
// A take verb-pair-flags.txt skips (network, publishing, signing, a device) and nothing else covers is counted as
// skipped, not covered. Exit 1 on any take neither covered nor skipped.
//
// A verb counts as covered when a file under test/call names it as a CLI argument (`['make', ...]`,
// `seed(['scan', ...])`, `term look ...`). That is deliberately generous: the point is to find the verbs with NOTHING.
//
// Run: pnpm term:cli-coverage           (report; non-zero if a verb or a take has no test)
//      pnpm term:cli-coverage --list    (just the tables)

import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { planRows, readRows, readRoutes } from './verb-pair'
import { TERM_ROOT } from './root'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = TERM_ROOT
const CALL_TESTS = join(TERM, 'test/call')

// Verbs with no test today. A BASELINE, not permission: this fails if a verb outside the list loses its coverage,
// and fails if a verb on it gains some, so the list cannot rot. Emptying it is term-cli-0002.
//
// A test must not NAME a verb it does not exercise. Mentioning one verb inside another's test claims coverage that
// does not exist, and that happened twice while writing these: `boot` read as covered because a `halt` assertion
// quoted the phrase it prints, and `mold`/`show` because the doc generator names every verb by construction.
const KNOWN_UNTESTED = new Set<string>([])

// Neither a blanket sweep nor a doc generator is per-verb coverage, and counting one as such is exactly the "no check
// fires on it is not someone verified it" mistake this project exists to avoid.
//
//   bad-input.ts asserts ONE property (bad input answers in words, not a stack trace) across the whole table. It says
//     nothing about whether a verb does its job. Reading it here made twelve verbs look tested overnight, several of
//     them only because the file NAMES them in a comment.
//   commands.ts GENERATES note/project/term/commands.md by running `term <verb> --help`. It touches every verb by definition.
//
// term-cli-0002 still means a test of what the verb does.
const NOT_COVERAGE = ['bad-input.ts', 'commands.ts']

function testFiles(): string[] {
  if (!existsSync(CALL_TESTS)) {
    return []
  }

  return readdirSync(CALL_TESTS)
    .filter(name => name.endsWith('.ts') && !NOT_COVERAGE.includes(name))
    .map(name => readFileSync(join(CALL_TESTS, name), 'utf8'))
}

function escaped(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// the verb named as a CLI argument: `'make'` in an argv array, or after `term `/`seed ` in a command string
function namesVerb(text: string, verb: string): boolean {
  return new RegExp(`(['"\`])${escaped(verb)}\\1|\\b(?:term|seed)\\s+${escaped(verb)}\\b`).test(text)
}

// ONE COMMAND LINE of a test: the string literals directly inside one argument list or array (`term('make', '--emit',
// target)`, `[LINE, 'self', 'find', '--range', r]`), or the words of one literal that runs the CLI (`'term make --emit
// node'`). A take is covered by a test only when its flag stands in the same line as its whole command path, after it
// (term-cli-in-term-0230: a line naming `make` anywhere and `--out` anywhere had covered every --out)
function commandLines(text: string): string[][] {
  const lines: string[][] = []
  const stack: string[][] = [[]]
  let at = 0

  while (at < text.length) {
    const char = text[at] as string

    if (char === '/' && text[at + 1] === '/') {
      const end = text.indexOf('\n', at)
      at = end === -1 ? text.length : end
      continue
    }

    if (char === '/' && text[at + 1] === '*') {
      const end = text.indexOf('*/', at + 2)
      at = end === -1 ? text.length : end + 2
      continue
    }

    if (char === "'" || char === '"' || char === '`') {
      let end = at + 1
      let value = ''

      while (end < text.length && text[end] !== char) {
        if (text[end] === '\\') {
          value += text[end + 1] ?? ''
          end += 2
          continue
        }

        value += text[end]
        end++
      }

      ;(stack[stack.length - 1] as string[]).push(value)
      const run = /\b(?:term|seed)\s+(.*)$/s.exec(value)

      if (run) {
        lines.push((run[1] as string).split(/\s+/).filter(Boolean))
      }

      at = end + 1
      continue
    }

    if (char === '(' || char === '[') {
      stack.push([])
    } else if ((char === ')' || char === ']') && stack.length > 1) {
      lines.push(stack.pop() as string[])
    }

    at++
  }

  return lines.filter(line => line.length > 0)
}

const commandPaths = new Set<string>()

// the flag after the whole command path in one line, and the path not a parent of the command the line runs
function passesFlag(line: string[], path: string, take: string): boolean {
  const words = path.split(' ')

  for (let start = 0; start + words.length <= line.length; start++) {
    if (!words.every((word, index) => line[start + index] === word)) {
      continue
    }

    const next = line[start + words.length]

    if (next !== undefined && commandPaths.has(`${path} ${next}`)) {
      continue
    }

    if (line.slice(start + words.length).some(word => word === `--${take}` || word.startsWith(`--${take}=`))) {
      return true
    }
  }

  return false
}

const commands = readRoutes()
const plan = planRows(readRows(), commands)
const files = testFiles()
const verbs = [...new Set(commands.map(command => command.path.split(' ')[0] as string))].sort()
const coveredVerbs = new Set(verbs.filter(verb => files.some(text => namesVerb(text, verb))))

const listOnly = process.argv.includes('--list')
let regressed = 0
let improved = 0

for (const verb of verbs) {
  const has = coveredVerbs.has(verb)
  const known = KNOWN_UNTESTED.has(verb)

  if (listOnly) {
    console.log(`${has ? 'test ' : 'NONE '} ${verb}`)
    continue
  }

  if (has && known) {
    improved++
    console.log(`GAINED ${verb} now has a test, so take it off KNOWN_UNTESTED`)
  } else if (!has && !known) {
    regressed++
    console.log(`LOST   ${verb} has no test and is not on the baseline`)
  }
}

// the takes: a verb-pair row, or a test/call command line running the command with the flag
let covered = 0
let skipped = 0
const uncovered: string[] = []
const testLines = files.flatMap(text => commandLines(text))

for (const command of commands) {
  commandPaths.add(command.path)
}

for (const command of commands) {
  for (const take of command.takes) {
    const key = `${command.path} --${take.name}`
    const byTest = !take.positional && testLines.some(line => passesFlag(line, command.path, take.name))
    const has = plan.covered.has(key) || byTest

    if (listOnly) {
      console.log(`${has ? 'test ' : plan.skipped.has(key) ? 'skip ' : 'NONE '} ${key}`)
    }

    if (has) {
      covered++
    } else if (plan.skipped.has(key)) {
      skipped++
    } else {
      uncovered.push(key)
    }
  }
}

if (!listOnly) {
  for (const key of uncovered) {
    console.log(`NONE   ${key} has no verb-pair row and no test/call file passing it`)
  }

  console.log(
    `\nterm cli-coverage: ${verbs.length} verbs, ${coveredVerbs.size} with a test, ${verbs.length - coveredVerbs.size} without`,
  )
  console.log(`takes: ${covered} of ${plan.takes.length}, ${skipped} skipped`)
}

if (regressed > 0 || improved > 0 || uncovered.length > 0) {
  process.exit(1)
}
