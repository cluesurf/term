// SNAPSHOTS (decisions-2026-10.md, D11): `want snapshot, <text>` holds a text against the one stored in the test file's
// `<test>.snapshot.tree`, and `term test --update` writes that file. A project run as a person runs it: with no store
// each snapshot fails naming its line and the command that writes it, `--update` writes the store and passes, a second
// run passes against it, a change to the code fails with both texts, a text holding every character a literal escapes
// comes back exactly, a value that is not text is refused at the build, and `--update` is refused off node. On each
// native backend this machine has, the tests hold against the store node wrote.
// Run: npx tsx test/call/test-snapshot.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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

const line = join(process.cwd(), 'host', 'line.js')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'test-snapshot-')))
mkdirSync(join(root, 'code'), { recursive: true })
mkdirSync(join(root, 'test'), { recursive: true })
writeFileSync(join(root, 'deck.tree'), `deck @probe/snapshot\n  mark <0.0.1>\n`)

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

const run = (...args: string[]): { code: number | null; out: string } => {
  const ran = spawnSync('node', [line, 'test', ...args, '--color', 'never'], { cwd: root, encoding: 'utf8', timeout: 900_000 })

  // the report wraps a long reason onto an indented line; read as one line
  return { code: ran.status, out: `${ran.stdout}${ran.stderr}`.replace(/\n {4}(?=\S)/g, ' ') }
}

const empty = run()
ok('with no store, every snapshot test fails', empty.out.includes('2 tests · 0 passed · 2 failed') && empty.code === 1, empty.out)
ok('naming the line and the command that writes it', empty.out.includes('no snapshot is stored for line 6: term test --update writes it'), empty.out)

const updated = run('--update')
ok('--update passes and writes three', updated.out.includes('2 tests · 2 passed') && updated.out.includes('3 snapshots written') && updated.code === 0, updated.out)
ok('the store exists beside the test', existsSync(store))

const stored = existsSync(store) ? readFileSync(store, 'utf8') : ''
ok('as a hash from each phrase to its texts', stored.includes('list <greets two people>') && stored.includes('<hello ada>, <hello grace>'), stored)

const again = run()
ok('a second run holds against it', again.out.includes('2 tests · 2 passed') && again.code === 0, again.out)

const looked = spawnSync('node', [line, 'look', store, '--color', 'never'], { cwd: root, encoding: 'utf8' })
ok('the store is a data file `term look` reads', looked.status === 0, `${looked.stdout}${looked.stderr}`)

code('hi')
const changed = run()
ok('a change to the code fails the snapshot', changed.out.includes('1 failed') && changed.code === 1, changed.out)
ok('with both texts', changed.out.includes('left <hi ada>, right <hello ada>'), changed.out)
ok('the text holding every escaped character still holds', !changed.out.includes('Keeps every character'), changed.out)
code('hello')

const refused = run('--update', '--env', 'rust')
ok('--update is refused off node', refused.out.includes('Snapshots are written on node') && refused.code !== 0, refused.out)

writeFileSync(join(root, 'test', 'number.tree'), 'test <a number is no snapshot>\n  want snapshot, 3\n')
const number = run('--filter', 'number')
ok('a value that is not text is refused at the build', number.out.includes('expected text, found number') && number.code !== 0, number.out)
writeFileSync(join(root, 'test', 'number.tree'), 'test <a number shown is one>\n  want hold, true\n')

const have = (tool: string): boolean => spawnSync('which', [tool], { stdio: 'ignore' }).status === 0

for (const [env, tools] of [['rust', ['rustc']], ['swift', ['swiftc']], ['kotlin', ['kotlinc', 'java']]] as const) {
  if (!tools.every(have)) {
    console.log(`skip  ${env}: ${tools.join(' and ')} not here`)
    continue
  }

  const native = run('--env', env, '--filter', 'greet')
  ok(`${env}: the tests hold against the store node wrote`, native.out.includes('2 tests · 2 passed') && native.code === 0, native.out)
}

console.log(`\ntest-snapshot: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
