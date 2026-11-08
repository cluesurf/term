// SNAPSHOTS (decisions-2026-10.md, D11): `want snapshot, <text>` holds a text against the one stored in the test file's
// `<test>.snapshot.tree`, and `term test --commit` writes that file (decision 022 T2, item 0186: writers write only on
// `--commit`, and `--update` is its old spelling, still honored with a warning). A project run as a person runs it: with
// no store each snapshot fails naming its line and the command that writes it, `--commit` writes the store and passes, a
// second run passes against it, a change to the code fails with both texts, a text holding every character a literal
// escapes and every character the store's own syntax could misread comes back exactly, a change of one of its
// characters fails naming the line, `--update` still writes with the warning, a value that is not text is refused at
// the build, and `--commit` is refused off node. On each native backend this machine has, the tests hold against the
// store node wrote.
// Run: npx tsx test/call/test-snapshot.ts

import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tempDir } from '../temp'
import { LINE } from './cli'

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

const line = LINE
const root = realpathSync(tempDir('test-snapshot-'))
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(
  join(root, 'deck.tree'),
  `deck @probe/snapshot\n  mark <0.0.1>\n`,
)

const code = (greeting: string): void =>
  writeFileSync(
    join(root, 'code', 'greet.tree'),
    `task greet\n  take name, like text\n  like text\n  back <${greeting} {name}>\n\n# every character a text literal escapes, and a line break\ntask awkward\n  like text\n  back <a \\<b\\> \\{c\\} \\\\ d\\ne\\tf>\n`,
  )

code('hello')
writeFileSync(
  join(root, 'test', 'greet.tree'),
  [
    'load ../code/greet',
    '  find greet',
    '  find awkward',
    '',
    'test <greets two people>',
    '  want snapshot, greet(<ada>)',
    '  want snapshot',
    '    call greet',
    '      text <grace>',
    '',
    'test <keeps every character>',
    '  want snapshot, awkward()',
    '',
  ].join('\n'),
)

const store = join(root, 'test', 'greet.snapshot.tree')

const run = (
  ...args: string[]
): { code: number | null; out: string } => {
  const ran = spawnSync(
    'node',
    [line, 'test', ...args, '--color', 'never'],
    { cwd: root, encoding: 'utf8', timeout: 900_000 },
  )

  // the report wraps a long reason onto an indented line; read as one line
  return {
    code: ran.status,
    out: `${ran.stdout}${ran.stderr}`.replace(/\n {4}(?=\S)/g, ' '),
  }
}

const empty = run()
ok(
  'with no store, every snapshot test fails',
  empty.out.includes('2 tests · 0 passed · 2 failed') &&
    empty.code === 1,
  empty.out,
)
ok(
  'naming the line and the command that writes it',
  empty.out.includes(
    'no snapshot is stored for line 6: term test --commit writes it',
  ),
  empty.out,
)

const updated = run('--commit')
ok(
  '--commit passes and writes three',
  updated.out.includes('2 tests · 2 passed') &&
    updated.out.includes('3 snapshots written') &&
    updated.code === 0,
  updated.out,
)
ok('--commit gives no warning', !updated.out.includes('--update is'), updated.out)
ok('the store exists beside the test', existsSync(store))

const stored = existsSync(store) ? readFileSync(store, 'utf8') : ''
ok(
  'as a hash from each phrase to its texts',
  stored.includes('list <greets two people>') &&
    stored.includes('<hello ada>, <hello grace>'),
  stored,
)

const again = run()
ok(
  'a second run holds against it',
  again.out.includes('2 tests · 2 passed') && again.code === 0,
  again.out,
)

const looked = spawnSync(
  'node',
  [line, 'look', store, '--color', 'never'],
  { cwd: root, encoding: 'utf8' },
)
ok(
  'the store is a data file `term look` reads',
  looked.status === 0,
  `${looked.stdout}${looked.stderr}`,
)

code('hi')
const changed = run()
ok(
  'a change to the code fails the snapshot',
  changed.out.includes('1 failed') && changed.code === 1,
  changed.out,
)
ok(
  'with both texts',
  changed.out.includes('left <hi ada>, right <hello ada>'),
  changed.out,
)
ok(
  'the text holding every escaped character still holds',
  !changed.out.includes('Keeps every character'),
  changed.out,
)
code('hello')

// a text holding what the store's own syntax could misread: a backslash, both angle brackets doubled and alone, both
// braces, a line break, a carriage return, a tab, trailing spaces, blank lines and a character past U+FFFF, and the empty
// text beside it. Written in Term's own escapes, `two` the word one run changes
const escapeCode = (two: string): string =>
  String.raw`task tricky
  like text
  back <\\ \< \> \{ \} \<\< \>\> end\nline ${two}\r\ttab  \n\n\nafter blanks 𝄞  >
`
writeFileSync(join(root, 'code', 'escape.tree'), escapeCode('two'))
writeFileSync(
  join(root, 'test', 'escape.tree'),
  [
    'load ../code/escape',
    '  find tricky',
    '',
    'test <keeps what the store could misread>',
    '  want snapshot, tricky()',
    '  want snapshot, <>',
    '',
  ].join('\n'),
)
const escaped = run('escape', '--commit')
ok(
  '--commit records the text the store could misread, and the empty text',
  escaped.out.includes('1 test · 1 passed') &&
    escaped.out.includes('2 snapshots written') &&
    escaped.code === 0,
  escaped.out,
)
const escapeHeld = run('escape')
ok(
  'node holds both against the store',
  escapeHeld.out.includes('1 test · 1 passed') && escapeHeld.code === 0,
  escapeHeld.out,
)
writeFileSync(join(root, 'code', 'escape.tree'), escapeCode('tw0'))
const moved = run('escape')
ok(
  'one character changed fails, naming the line',
  moved.out.includes('1 failed') &&
    moved.out.includes('test/escape.tree:5') &&
    moved.code === 1,
  moved.out,
)
const spelled = run('escape', '--update')
ok(
  '--update still writes, with the warning',
  spelled.out.includes('2 snapshots written') &&
    spelled.out.includes('term test --update is term test --commit now') &&
    spelled.code === 0,
  spelled.out,
)
const spelledHeld = run('escape')
ok(
  'and what it wrote holds',
  spelledHeld.out.includes('1 test · 1 passed') && spelledHeld.code === 0,
  spelledHeld.out,
)
writeFileSync(join(root, 'code', 'escape.tree'), escapeCode('two'))
const back = run('escape', '--commit')
ok('--commit writes the first text back', back.code === 0, back.out)

const refused = run('--commit', '--env', 'rust')
ok(
  '--commit is refused off node',
  refused.out.includes('Snapshots are written on node: --commit runs without --env') &&
    refused.code !== 0,
  refused.out,
)

writeFileSync(
  join(root, 'test', 'number.tree'),
  'test <a number is no snapshot>\n  want snapshot, 3\n',
)
const number = run('--filter', 'number')
ok(
  'a value that is not text is refused at the build',
  number.out.includes('expected text, found number') &&
    number.code !== 0,
  number.out,
)
writeFileSync(
  join(root, 'test', 'number.tree'),
  'test <a number shown is one>\n  want hold, true\n',
)

const have = (tool: string): boolean =>
  spawnSync('which', [tool], { stdio: 'ignore' }).status === 0

for (const [env, tools] of [
  ['rust', ['rustc']],
  ['swift', ['swiftc']],
  ['kotlin', ['kotlinc', 'java']],
] as const) {
  if (!tools.every(have)) {
    console.log(`skip  ${env}: ${tools.join(' and ')} not here`)
    continue
  }

  const native = run('--env', env, '--filter', 'greet')
  ok(
    `${env}: the tests hold against the store node wrote`,
    native.out.includes('2 tests · 2 passed') && native.code === 0,
    native.out,
  )

  const nativeEscape = run('--env', env, 'escape')
  ok(
    `${env}: the text the store could misread holds against what node wrote`,
    nativeEscape.out.includes('1 test · 1 passed') && nativeEscape.code === 0,
    nativeEscape.out,
  )
}

console.log(`\ntest-snapshot: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
