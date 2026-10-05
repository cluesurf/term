// `term halt` stops a project's own `term boot`, through the boot (note/term/gaps/plan.md, phase 8, "Running a
// program"). Until 2026-10-04 bare `halt` stopped every boot on the machine, and it stopped the PROGRAM, so the boot
// that started it stayed, watching, with nothing to serve. Two real servers, one in each of two projects.
//
// Run: npx tsx test/call/halt.ts (after `pnpm run make:line`)

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')

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

const ROUTE = `load @term/site/dom/dom
  find view

load @term/site/view/native/{platform}/host
  find host

view home
  take host, like view
  view h1, <Shelf>

hook /
  view home
`

type Booted = { child: ChildProcess; dir: string; log: () => string; exited: Promise<number | null> }

async function boot(name: string, port: number): Promise<Booted> {
  const dir = mkdtempSync(join(tmpdir(), `term-halt-${name}-`))
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'deck.tree'), `deck ${name}\n  mark <0.0.1>\n`)
  writeFileSync(join(dir, 'code/route.tree'), ROUTE)

  // production: no watchers, so the boot ends when its program does
  const child = spawn('node', [LINE, 'boot', 'code/route.tree', '--port', String(port)], {
    cwd: dir,
    env: { ...process.env, NO_COLOR: '1', NODE_ENV: 'production' },
  })
  let log = ''
  child.stdout!.on('data', chunk => (log += String(chunk)))
  child.stderr!.on('data', chunk => (log += String(chunk)))
  const exited = new Promise<number | null>(done => child.once('exit', code => done(code)))
  const started = Date.now()

  while (!/✓ start/.test(log) && Date.now() - started < 60_000 && child.exitCode === null) {
    await new Promise(done => setTimeout(done, 100))
  }

  return { child, dir, log: () => log, exited }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T | 'timeout'> {
  return Promise.race([promise, new Promise<'timeout'>(done => setTimeout(() => done('timeout'), ms))])
}

const a = await boot('halt-a', 4981)
const b = await boot('halt-b', 4982)

try {
  ok('both projects are serving', /✓ start/.test(a.log()) && /✓ start/.test(b.log()), `${a.log().slice(-300)} | ${b.log().slice(-300)}`)

  const halted = spawnSync('node', [LINE, 'halt'], { cwd: a.dir, encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  const said = `${halted.stdout}${halted.stderr}`
  ok('`term halt` in a project names it as this project\'s boot, and stops one', halted.status === 0 && /this project's term boot/.test(said) && /1 instance/.test(said), said)

  const aEnd = await within(a.exited, 15_000)
  ok('the boot itself ends, not only its program', aEnd !== 'timeout', a.log().slice(-400))
  ok('and closes with its own item', /Stopped/.test(a.log()), a.log().slice(-400))

  const bAlive = await within(b.exited, 1_000)
  ok('the other project\'s boot is still serving', bAlive === 'timeout' && b.child.exitCode === null, b.log().slice(-300))

  const byPort = spawnSync('node', [LINE, 'halt', '-p', '4982'], { cwd: tmpdir(), encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } })
  ok('`term halt -p` stops the program on that port', byPort.status === 0 && /:4982/.test(`${byPort.stdout}${byPort.stderr}`), `${byPort.stdout}${byPort.stderr}`)
  ok('and the boot that started it ends too', (await within(b.exited, 15_000)) !== 'timeout', b.log().slice(-400))
} finally {
  a.child.kill()
  b.child.kill()
}

console.log(`\nhalt: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
