// Which term runs here (deck/call/code/need.ts), one case per rule of note/term/plan/term-versions.md "Resolution",
// plus nearest-wins, a stale pin, a pin not installed, and every refusal. Real files in a scratch directory: a home with
// installed versions, projects with deck.tree and lock.tree. No network: resolution never reaches one.
// Run: npx tsx test/call/need-resolve.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chooseVersion, splitFlag, type NeedChoice, type NeedWorld } from '@term/call/code/need'

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

const root = mkdtempSync(join(tmpdir(), 'term-need-'))
const home = join(root, 'home')

// installed: 2.6.2, 2.6.4, 2.7.0 (each a directory with an install.tree)
for (const version of ['2.6.2', '2.6.4', '2.7.0']) {
  mkdirSync(join(home, 'code', version, 'term', 'bin'), { recursive: true })
  writeFileSync(join(home, 'code', version, 'install.tree'), `install\n  code <${version}>\n  form <darwin-arm64>\n  hash <sha256:x>\n`)
}

// a not-a-version directory and a version without an install.tree are not installs
mkdirSync(join(home, 'code', '.2.8.0.123'), { recursive: true })
mkdirSync(join(home, 'code', '2.9.0'), { recursive: true })

function project(name: string, need?: string, pin?: string): string {
  const dir = join(root, name)

  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'deck.tree'), `deck @alice/${name}\n  mark <1.0.0>\n${need ? `  need ${need}\n` : ''}`)

  if (pin) {
    writeFileSync(join(dir, 'lock.tree'), `lock <1>\n\nneed @term/code\n  code <${pin}>\n  hash <sha256:${'a'.repeat(64)}>\n`)
  }

  return dir
}

const none = project('none')
const sixes = project('sixes', '@term/code, mark <2.6.x>')
const pinned = project('pinned', '@term/code, mark <2.6.x>', '2.6.2')
const stale = project('stale', '@term/code, mark <2.7.x>', '2.6.2')
const missing = project('missing', '@term/code, mark <2.5.x>', '2.5.0')
const future = project('future', '@term/code, mark <3.x.x>')
const other = project('other', '@alice/tool, mark <1.x.x>')
const nested = join(sixes, 'inner', 'deeper')
const innerProject = project(join('sixes', 'pkg'), '@term/code, mark <2.7.x>')

mkdirSync(nested, { recursive: true })

function world(input: Partial<NeedWorld> & { cwd: string }): NeedWorld {
  return { argv: ['make'], env: {}, home, running: '2.6.4', ...input }
}

function run(input: Partial<NeedWorld> & { cwd: string }): NeedChoice {
  return chooseVersion(world(input)).choice
}

function is(choice: NeedChoice, form: NeedChoice['form'], version?: string, by?: string): boolean {
  if (choice.form !== form) {
    return false
  }

  if (version !== undefined && (choice.form === 'refuse' || choice.version !== version)) {
    return false
  }

  return by === undefined || (choice.form === 'run' && choice.by === by)
}

const show = (choice: NeedChoice) => JSON.stringify({ ...choice, request: undefined })

// 1  +flag
{
  const choice = chooseVersion(world({ cwd: sixes, argv: ['+2.7.x', 'make', '--trees'] }))

  ok('1. +flag wins over the project, and is stripped from the arguments', is(choice.choice, 'run', '2.7.0', 'installed') && choice.argv.join(' ') === 'make --trees', show(choice.choice))
  ok('   splitFlag leaves an ordinary first argument alone', splitFlag(['+x', 'a']).argv.length === 2 && splitFlag(['make']).text === undefined)
}

// 2  TERM_VERSION
ok('2. TERM_VERSION wins over the project', is(run({ cwd: sixes, env: { TERM_VERSION: '2.6.2' } }), 'run', '2.6.2'), show(run({ cwd: sixes, env: { TERM_VERSION: '2.6.2' } })))
ok('   +flag wins over TERM_VERSION', is(run({ cwd: none, argv: ['+2.7.0'], env: { TERM_VERSION: '2.6.2' } }), 'run', '2.7.0'))

// 3  the project
ok('3. a project range runs the newest installed in range', is(run({ cwd: sixes }), 'run', '2.6.4', 'installed'), show(run({ cwd: sixes })))
ok('   from a subdirectory, walking up', is(run({ cwd: nested }), 'run', '2.6.4'), show(run({ cwd: nested })))
ok('   nearest wins: a nested package with its own need', is(run({ cwd: innerProject }), 'run', '2.7.0'), show(run({ cwd: innerProject })))
ok('   a pin that satisfies the range runs exactly the pin', is(run({ cwd: pinned }), 'run', '2.6.2', 'pin'), show(run({ cwd: pinned })))
ok('   a stale pin (outside the range) is passed over for the range', is(run({ cwd: stale }), 'run', '2.7.0', 'installed'), show(run({ cwd: stale })))
{
  const choice = run({ cwd: missing })

  ok('   a pin not installed is a load of exactly it, with its digest', choice.form === 'load' && choice.version === '2.5.0' && choice.expect === `sha256:${'a'.repeat(64)}`, show(choice))
}
{
  const choice = run({ cwd: future })

  ok('   a range nothing installed satisfies is a load of the range', choice.form === 'load' && choice.version === undefined, show(choice))
}
ok('   a need naming another package is refused, with the file', run({ cwd: other }).form === 'refuse' && /only @term\/code can be needed/.test((run({ cwd: other }) as { reason: string }).reason))

// 4  the default
writeFileSync(join(home, 'need.tree'), 'need @term/code, mark <2.6.2>\n')
ok('4. the default applies outside any project', is(run({ cwd: none }), 'run', '2.6.2'), show(run({ cwd: none })))
ok('   and the project still wins over it', is(run({ cwd: sixes }), 'run', '2.6.4'))
writeFileSync(join(home, 'need.tree'), '\n')

// 5  the newest installed
ok('5. no request anywhere: the newest installed', is(run({ cwd: none }), 'run', '2.7.0', 'installed'), show(run({ cwd: none })))
ok('   a version directory without an install.tree is not an install', !['2.9.0', '2.8.0'].includes((run({ cwd: none }) as { version: string }).version))

// 6  the running copy
{
  const bare = join(root, 'bare-home')

  mkdirSync(bare, { recursive: true })
  ok('6. nothing installed: the running copy', is(chooseVersion({ argv: ['make'], env: {}, cwd: none, home: bare, running: '2.6.4' }).choice, 'run', '2.6.4', 'running'))
  ok('   and the running copy answers a range it is in, with nothing installed', is(chooseVersion({ argv: ['make'], env: {}, cwd: sixes, home: bare, running: '2.6.4' }).choice, 'run', '2.6.4', 'running'))
}

// refusals
ok('a +flag that is not a version is refused', run({ cwd: none, argv: ['+2.x.y', 'make'] }).form === 'refuse')
ok('a TERM_VERSION that is not a version is refused', run({ cwd: none, env: { TERM_VERSION: 'latest' } }).form === 'refuse')

console.log(`\nneed-resolve: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
