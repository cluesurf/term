// `term walk`, the REPL, driven the only way a test can drive it: through a pipe.
//
// WHAT THIS FOUND. `term walk` did not work on piped input AT ALL. It printed its banner, a prompt and `bye`, and
// evaluated nothing, whatever it was given.
//
// Two causes, one behind the other, and both invisible to a person typing:
//
//   READLINE DOES NOT AWAIT AN ASYNC `line` LISTENER. Typing, each line finishes long before the next arrives.
//   Piped, every queued line fires back to back and `close` follows immediately, and `close` called
//   `process.exit(0)`, which killed every evaluation still in flight.
//
//   AND THE BUFFER MUTATED OUTSIDE THE QUEUE. Chaining only the flush was not enough: the listener still ran for
//   every line before a single queued job did, so the buffer already held the entire input when the first flush
//   looked at it, and a definition block swallowed every expression typed after it.
//
// A pasted block is the same case as a pipe, so neither of these was only about scripts.
//
// It also asserts the REPL says TERM. It announced itself as `Seed REPL` and prompted with `seed> `, which is the
// pre-rename name, on the first line a person sees.
//
// Run: npx tsx test/call/walk.ts

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const LINE = join(TERM, 'host/line.js')

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${info ? `  ${info.slice(0, 400)}` : ''}`)
  }
}

const box = mkdtempSync(join(tmpdir(), 'term-walk-'))
const home = join(box, 'home')

mkdirSync(home, { recursive: true })

// the REPL, fed a script on stdin. BOTH streams: a value prints on stdout and a defect on stderr.
function walk(input: string): string {
  const run = spawnSync('node', [LINE, 'walk'], {
    cwd: box,
    input,
    encoding: 'utf8',
    timeout: 180000,
    env: { ...process.env, HOME: home },
  })

  return `${run.stdout ?? ''}${run.stderr ?? ''}`
}

// ---- it is the Term REPL ----

const opened = walk('exit\n')

ok('the REPL announces itself as Term', /Term REPL/.test(opened), opened)
ok('and prompts with `term>`, not `seed>`', /term> /.test(opened) && !/seed> /.test(opened), opened)

// ---- an expression evaluates ----

const added = walk('call add(code 2, code 3)\n\nexit\n')

ok('a one-line expression evaluates and prints its value', /\b5\b/.test(added), added)

// ---- a definition is kept, and used by what follows it ----
//
// The definition is the case the second defect broke: a block waits for a blank line, so it is the only input that
// spans more than one `line` event, and everything after it went into the same buffer.

const script = [
  'task twice',
  '  take n, like number',
  '  like number',
  '  send back',
  '    call multiply(read(n), code 2)',
  '',
  'call twice(code 21)',
  '',
  'exit',
  '',
].join('\n')

const ran = walk(script)

ok('a definition is added', /added twice/.test(ran), ran)

ok(
  'and the expression after it CALLS it: twice(21) is 42',
  /\b42\b/.test(ran),
  ran,
)

// ---- a defect is reported rather than swallowed ----

const bad = walk('call nope(code 1)\n\nexit\n')

ok(
  'an unknown name is reported, and the REPL carries on to say goodbye',
  /is not defined/.test(bad) && /bye/.test(bad),
  bad,
)

// ---- input that ends without a blank line is still evaluated ----
//
// A script file rarely ends in a blank line, and a block left in the buffer at `close` used to be dropped without
// a word. Ending on the expression itself, with no `exit` and no trailing blank, is the ordinary shape of
// `term walk < script.tree`.

const unterminated = walk('call add(code 20, code 20)')

ok(
  'a script that ends mid-block is still evaluated rather than dropped',
  /\b40\b/.test(unterminated),
  unterminated,
)

console.log(`\nwalk: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
