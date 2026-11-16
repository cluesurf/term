// `halt kink, e` in a guard's handler raises the caught value again, unchanged, on TypeScript, Rust, Swift and Kotlin
// (term/compiler decision 023, item term-self-host-001-1575). Before it the minter made `halt kink` as a statement into
// a `break`: inside a loop it left the loop with nothing raised, and outside one it was refused as "only valid inside a
// loop".
//
// raise-again-native/again.tree catches a form with a link prop in a cleanup, raises it again, and prints the outer
// catch beside the first: form, note, code, time and the prop equal. The same for a native call's raise (a file read of
// a path that is not there), and for a raise again inside a walk, which raises at its first turn and never breaks the
// loop. Its standard output is again.golden on every backend. Then, compiled for node: the raise set is the guarded
// body's (the cleanup raises `lost-thing`, the tidy the read's own set, a failure-only cleanup `failure` with a caller
// that owes nothing, never `exception`), a field typed `exception` and a list's element raise again as `exception`, a
// handler that saves over its caught name raises `exception`, and the refusals: a bare `halt kink` statement, a value
// not typed `exception` (a text, a number, a record, an `unknown`, a `dynamic`), and an exception form's make (087).
// Run: npx tsx test/compile/raise-again-native.ts   (AGAIN_ONLY=typescript, rust, swift or kotlin runs one backend)

import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const read = (name: string): string =>
  readFileSync(join(HERE, 'raise-again-native', name), 'utf8')
const root = mkdtempSync(join(tmpdir(), 'term-raise-again-'))
mkdirSync(join(root, 'link/@term'), { recursive: true })
mkdirSync(join(root, 'code'), { recursive: true })
symlinkSync(join(TERM, 'deck/base'), join(root, 'link/@term/base'))
writeFileSync(
  join(root, 'deck.tree'),
  'deck @probe/raise-again\n  code <0.0.0>\n',
)
const out = join(root, 'out')
mkdirSync(out, { recursive: true })
const PROGRAM = read('again.tree')
const GOLDEN = read('again.golden')
const only = process.env.AGAIN_ONLY ?? ''
const outputs = new Map<string, string>()

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({
    backend,
    program: PROGRAM,
    resolve: env => projectResolver(root, env),
    dir: out,
    name: `again-${backend}`,
    file: join(root, 'code', 'again.tree'),
  })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  if (ran.form === 'ran') {
    outputs.set(backend, ran.output)
  }

  ok(
    `${backend}: a caught value raised again keeps its form, note, code, time and prop, and a walk raises`,
    ran.form === 'ran' && ran.output === GOLDEN,
    ran.form === 'ran'
      ? `got ${JSON.stringify(ran.output)}`
      : `${ran.stage}: ${ran.reason.slice(0, 900)}`,
  )
}

ok(
  'the output is the same bytes on every backend run',
  outputs.size > 0 &&
    [...outputs.values()].every(one => one === [...outputs.values()][0]),
  [...outputs.keys()].join(', '),
)

// ---- compiled for node: the raise sets and the refusals ----

type Result = ReturnType<typeof compile>

const build = (name: string, text: string): Result => {
  const file = join(root, 'code', `${name}.tree`)
  writeFileSync(file, text)

  return compile(
    { file, text },
    { resolve: projectResolver(root, 'node'), env: 'node', roll: true },
  )
}

const messages = (result: Result): string =>
  (result.diagnostics ?? [])
    .filter(d => d.severity !== 'warning')
    .map(d => `${d.name}: ${d.message}`)
    .join(' | ')

// the exceptions the roll says a task raises
const halts = (result: Result, name: string): string[] => {
  const entry = (result.roll?.task ?? []).find(e => e.name === name)

  return ((entry?.halt as string[] | undefined) ?? []).slice().sort()
}

const sets = build('sets', PROGRAM)
ok('the program builds for node', sets.ok, messages(sets))
ok(
  'a cleanup that raises a form again raises that form, not exception',
  JSON.stringify(halts(sets, 'clean-up')) === '["lost-thing"]',
  JSON.stringify(halts(sets, 'clean-up')),
)
ok(
  "a cleanup of a native call raises the call's own set, never exception",
  JSON.stringify(halts(sets, 'tidy')) === '["absence","failure"]',
  JSON.stringify(halts(sets, 'tidy')),
)
ok(
  'a raise again in a walk raises the form',
  JSON.stringify(halts(sets, 'walk-again')) === '["lost-thing"]',
  JSON.stringify(halts(sets, 'walk-again')),
)

const HEAD = `load @term/base/exception
  find exception

load @term/base/list
  find list

form lost-thing
  like exception
    bind note, <Lost>
    link where-from, like text

form holder
  link caught, like exception

form plain
  link x, like text

task lose
  like number
  halt lost-thing
    bind where-from, <a/b>
`

// a handler around lose() whose last lines are the given ones
const handler = (lines: string, takes = ''): string => `${HEAD}
task cleanup
${takes}  like number
  fork
    mark unsafe
    back lose()
  halt take
    take problem
${lines}
`

const field = build(
  'field',
  `${HEAD}
task pass-on
  take box, like holder
  like number
  halt kink, box/caught

task first-again
  take all, like list, like exception
  like number
  halt kink, all/0
`,
)
ok('a field typed exception and a list element raise again', field.ok, messages(field))
ok(
  'a field raised again raises exception',
  JSON.stringify(halts(field, 'pass-on')) === '["exception"]',
  JSON.stringify(halts(field, 'pass-on')),
)
ok(
  'a list element raised again raises exception',
  JSON.stringify(halts(field, 'first-again')) === '["exception"]',
  JSON.stringify(halts(field, 'first-again')),
)

// a body of failure-only raises, raised again: the set is failure, and a caller with no halt kink builds
const failing = build(
  'failing',
  `${HEAD}
task risky
  take n, like number
  like number
  fork test, is-above(n, 3)
    hold
      halt <too big>
  back n

task tidy-up
  take n, like number
  like number
  fork
    mark unsafe
    back risky(n)
  halt take
    take problem
    halt kink, problem

task caller
  like number
  back tidy-up(9)
`,
)
ok('a failure-only cleanup and its caller with no halt kink build', failing.ok, messages(failing))
ok(
  'and the cleanup raises failure only',
  JSON.stringify(halts(failing, 'tidy-up')) === '["failure"]',
  JSON.stringify(halts(failing, 'tidy-up')),
)

const saved = build(
  'saved',
  handler('    save problem, box/caught\n    halt kink, problem', '  take box, like holder\n'),
)
ok('a handler that saves over its caught name builds', saved.ok, messages(saved))
ok(
  'and raises exception, not the body set',
  JSON.stringify(halts(saved, 'cleanup')) === '["exception"]',
  JSON.stringify(halts(saved, 'cleanup')),
)

const bare = build('bare', handler('    halt kink'))
ok(
  'a bare halt kink statement is refused, naming both meanings',
  !bare.ok &&
    messages(bare).includes('has nothing to raise') &&
    messages(bare).includes('Under a call'),
  messages(bare),
)

const refused: [string, string, string][] = [
  ['text', '    halt kink, <gone>', ''],
  ['number', '    halt kink, 3', ''],
  [
    'record',
    '    save made\n      make plain\n        bind x, <x>\n    halt kink, made',
    '',
  ],
  ['unknown', '    halt kink, v', '  take v, like unknown\n'],
  ['dynamic', '    halt kink, v', '  take v, like dynamic\n'],
]

// an exception form's make is refused already, by decision 087 (made-exception), before it can be raised again
const made = build(
  'refused-form-make',
  handler('    save made\n      make lost-thing\n        bind where-from, <x>\n    halt kink, made'),
)
ok(
  "a raise again of an exception form's make is refused",
  !made.ok &&
    (messages(made).includes('made-exception') ||
      messages(made).includes('again-not-caught')),
  messages(made) || 'compiled',
)

for (const [name, lines, takes] of refused) {
  const result = build(`refused-${name}`, handler(lines, takes))
  ok(
    `a raise again of a ${name} is refused as again-not-caught`,
    !result.ok && messages(result).includes('again-not-caught'),
    messages(result) || 'compiled',
  )
}

console.log(`\nraise-again-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
