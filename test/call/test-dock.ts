// `term test` resolves a dock as the project's own build resolves it (decision 009, term-cli-in-term-0174). The project
// test/call/test-dock-fixture/ has one test file docking (a) an npm package in its own node_modules and (b) a .ts module
// its tsconfig.json `paths` maps. Each is held through units and merged: both tests pass, the module was built inside
// the project's cache and never os.tmpdir(), the kept bundle lists the source it inlined, a second run reuses it, and an
// edit of that source rebuilds it (the edited answer is seen, not the kept one).
// Run from deck/term/deck/term: npx tsx test/call/test-dock.ts

import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
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

const here = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const line = LINE
const fixture = join(here, 'test', 'call', 'test-dock-fixture')

// the fixture copied to a project of its own, its package installed in its node_modules as npm would
const root = realpathSync(tempDir('test-dock-'))
cpSync(fixture, root, { recursive: true })
mkdirSync(join(root, 'node_modules'), { recursive: true })
cpSync(join(root, 'vendor', 'probe-dock-package'), join(root, 'node_modules', 'probe-dock-package'), { recursive: true })

// TERM_TEST_DOCK_CLI: the node arguments that start another CLI, space-separated, in place of the CLI test/call/cli.ts names (a saved
// line.js, or the tsx loader and deck/call/code/line.ts)
const cli = process.env.TERM_TEST_DOCK_CLI ? process.env.TERM_TEST_DOCK_CLI.split(' ') : [line]

function test(...flags: string[]): { code: number | null; out: string } {
  const ran = spawnSync('node', [...cli, 'test', '--color', 'never', ...flags], { cwd: root, encoding: 'utf8', timeout: 600_000 })

  return { code: ran.status, out: `${ran.stdout}${ran.stderr}` }
}

const kept = join(root, '.base', '@term', 'code', 'cache', 'test')

function bundles(): { file: string; time: number }[] {
  return existsSync(kept)
    ? readdirSync(kept)
        .filter(name => name.endsWith('.mjs'))
        .map(name => ({ file: name, time: statSync(join(kept, name)).mtimeMs }))
    : []
}

const first = test()
ok('through units: both docks resolve and both tests pass', first.code === 0 && first.out.includes('2 tests · 2 passed'), first.out)

const built = bundles()
ok('the module is kept inside the project cache', built.length === 1, JSON.stringify(built))
ok('the module was built in the project, under its cache test/run/', existsSync(join(kept, 'run')) && readdirSync(join(kept, 'run')).length > 0)

const listing = built[0] ? join(kept, built[0].file.replace(/\.mjs$/, '.inputs.json')) : ''
const inlined = listing && existsSync(listing) ? (JSON.parse(readFileSync(listing, 'utf8')) as { path: string }[]) : []
ok(
  'the kept bundle lists the tsconfig-mapped source it inlined, and not the npm package',
  inlined.some(one => one.path === join(root, 'shared', 'greeting.ts')) && !inlined.some(one => one.path.includes('probe-dock-package')),
  JSON.stringify(inlined),
)

const second = test()
const again = bundles()
ok('a second run passes and reuses the kept bundle', second.code === 0 && again.length === 1 && again[0]!.time === built[0]!.time, `${second.out}\n${JSON.stringify(again)}`)

// the inlined source edited: the kept bundle is not reused, and the test sees the new answer
const greeting = join(root, 'shared', 'greeting.ts')
const original = readFileSync(greeting, 'utf8')
writeFileSync(greeting, original.replace('`hello ${name}`', '`hi ${name}`'))
const edited = test()
ok('an edit of an inlined source rebuilds the bundle: the mapped test now fails', edited.code !== 0 && edited.out.includes('hello ada'), edited.out)
writeFileSync(greeting, original)

const merged = test('--merged')
ok('merged: both docks resolve and both tests pass', merged.code === 0 && merged.out.includes('2 tests · 2 passed'), merged.out)

const runs = existsSync(join(kept, 'run')) ? readdirSync(join(kept, 'run')) : []
ok('the merged module was built in the project too', runs.some(name => name.startsWith('merged')), JSON.stringify(runs))

console.log(`\ntest-dock: ${pass} pass, ${fail} fail (project ${root})`)
process.exit(fail > 0 ? 1 : 0)
