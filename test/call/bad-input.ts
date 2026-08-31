// Every `term` verb, fed bad input, answers with a DIAGNOSTIC rather than a stack trace.
//
// WHY THIS EXISTS. The CLI is the surface most people touch, and a crash is the worst thing it can do: it says
// nothing about what went wrong, nothing about what to do, and it leaks the machine's own paths. Five verbs (`host`,
// `load`, `note`, `save`, `toss`) all reached the manifest through one function, and every one of them printed
//
//   ENOENT: no such file or directory, open '/private/var/folders/8x/z26.../T/tmp.pQBAV0ypyb/deck.tree'
//
// when run outside a project, which is the ordinary way to make that mistake. That is now a sentence, and this holds
// it so, for every verb rather than those five.
//
// WHAT COUNTS AS A CRASH: a `at <fn> (<file>:<line>:<col>)` frame, or a raw runtime error class (TypeError,
// ReferenceError) or a bare errno (ENOENT, EACCES) reaching the output. A verb is free to fail, and most of these
// SHOULD fail on this input. It has to fail in words.
//
// Run: npx tsx test/call/bad-input.ts

import { execFileSync } from 'node:child_process'
import { readFileSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')

// the verbs, read from the CLI's own table so a new one is covered the day it is added
function verbs(): string[] {
  const text = readFileSync(join(TERM, 'deck/call/code/line.ts'), 'utf8')
  const at = text.indexOf('const COMMANDS = [')

  if (at < 0) {
    throw new Error('COMMANDS table not found in deck/call/code/line.ts')
  }

  const block = text.slice(at, text.indexOf(']', at) + 1)

  return [...new Set([...block.matchAll(/'([a-z-]+)'/g)].map(m => m[1]!))].sort()
}

// a stack frame, a raw runtime error class, or a bare errno
const CRASH =
  /^\s+at .+\(.*:\d+:\d+\)|\b(TypeError|ReferenceError|SyntaxError|RangeError|ENOENT|EACCES|EISDIR|ENOTDIR)\b/m

// verbs that start something long-lived or interactive rather than answering and exiting. They are given the same
// input and only have to not crash within the timeout; a timeout kill is not a crash.
const LONG = new Set(['walk', 'work', 'feed', 'wash', 'time', 'test', 'boot', 'zone', 'cast', 'hunt'])

let pass = 0
let fail = 0

function ok(name: string, good: boolean, detail = ''): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `  ${detail}` : ''}`)
  }
}

// an empty directory: no deck.tree, no .tree files, nothing. The ordinary way to be in the wrong place.
const empty = mkdtempSync(join(tmpdir(), 'term-bad-'))

for (const verb of verbs()) {
  let out = ''

  try {
    out = execFileSync('node', [LINE, verb, '--no-such-flag', 'no-such-path'], {
      cwd: empty,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: LONG.has(verb) ? 8000 : 30000,
    })
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string; killed?: boolean }

    // a long-running verb killed by the timeout said what it was going to say already
    out = `${e.stdout ?? ''}\n${e.stderr ?? ''}`
  }

  const crash = CRASH.exec(out)

  ok(
    `\`term ${verb}\` answers bad input in words`,
    crash === null,
    crash ? crash[0].trim().slice(0, 80) : '',
  )
}

console.log(`\nbad-input: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
