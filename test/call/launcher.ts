// The Windows launcher (task/launcher/term.go), built for THIS platform and run against a fake payload: reached through
// a link, as winget puts it on PATH, it must find the payload behind the link, hand Node host/need.mjs and every
// argument unchanged, and exit with Node's code. The source is the same one release.ts cross-compiles to term.exe.
// Run: npx tsx test/call/launcher.ts
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const TERM = join(import.meta.dirname, '..', '..')

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

const root = mkdtempSync(join(tmpdir(), 'term-launcher-'))
const payload = join(root, 'payload', 'term')
const exe = join(payload, 'bin', process.platform === 'win32' ? 'term.exe' : 'term-launcher')

mkdirSync(join(payload, 'bin'), { recursive: true })
mkdirSync(join(payload, 'host'), { recursive: true })

// the fake first module: says what it was given and where it is, and exits with a code the arguments choose
writeFileSync(
  join(payload, 'host', 'need.mjs'),
  "process.stdout.write(JSON.stringify({ args: process.argv.slice(2), at: import.meta.url })); process.exit(Number(process.argv.at(-1)) || 0)\n",
)

execFileSync('go', ['build', '-o', exe, join(TERM, 'task', 'launcher', 'term.go')], { env: { ...process.env, CGO_ENABLED: '0' } })

// winget's shape: a folder of links on PATH, each pointing into a package folder somewhere else
const links = join(root, 'links')

mkdirSync(links)
symlinkSync(exe, join(links, 'term'))

const run = spawnSync(join(links, 'term'), ['make', '--trees', 'a b', '7'], { encoding: 'utf8' })
const said = JSON.parse(run.stdout || '{}') as { args?: string[]; at?: string }

ok('reached through a link, it runs the payload behind the link', said.at?.includes(join('payload', 'term', 'host', 'need.mjs')) === true, run.stdout + run.stderr)
ok('every argument arrives unchanged, a space inside one included', JSON.stringify(said.args) === JSON.stringify(['make', '--trees', 'a b', '7']), JSON.stringify(said.args))
ok("it exits with Node's code", run.status === 7, String(run.status))

const noNode = spawnSync(join(links, 'term'), ['--version'], { encoding: 'utf8', env: { PATH: '/nonexistent' } })
ok('with no Node on PATH it says so, and exits 69', noNode.status === 69 && /needs Node\.js 22\.3\.0 or newer/.test(noNode.stderr), `${noNode.status} ${noNode.stderr}`)

console.log(`\nlauncher: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
