// The browser development server on the scaffold `term wake` writes (guides: commands/boot, "In a browser"): the page
// calls the program's `boot`, so its `log` reaches the browser console, and a port is checked before it is used. Until
// 2026-10-04 nothing called `boot`, the scaffold logged nothing, and a taken `-p` failed inside the server. It was
// `term feed` until 2026-10-05 and is `term boot --env browser` (development, the default) since
//
// Run: npx tsx test/call/feed.ts (after `pnpm run make:line`)

import { spawn, spawnSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')
const MESH = join(HERE, '../../../../../../mesh')

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

type Page = {
  on: (event: 'console' | 'pageerror', handler: (value: { text?: () => string } & Error) => void) => void
  goto: (url: string) => Promise<unknown>
  waitForTimeout: (ms: number) => Promise<void>
}
type Chromium = { launch: (o: { headless: boolean }) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> }

// the server's command line
const SERVE = ['boot', '--env', 'browser']

const project = mkdtempSync(join(tmpdir(), 'term-feed-'))
mkdirSync(join(project, 'code'))
writeFileSync(join(project, 'deck.tree'), 'deck hello\n  mark <0.0.1>\n  boot ./code/boot\n')
writeFileSync(join(project, 'code/boot.tree'), 'load @term/base/console\n  find log\n\ntask boot\n  mark async\n  log <hello from term>\n')

async function feed(args: string[]): Promise<{ child: ChildProcess; log: () => string }> {
  const child = spawn('node', [LINE, ...SERVE, ...args], { cwd: project, env: { ...process.env, NO_COLOR: '1' } })
  let log = ''
  child.stdout!.on('data', chunk => (log += String(chunk)))
  child.stderr!.on('data', chunk => (log += String(chunk)))
  const started = Date.now()

  while (!/✓ start/.test(log) && Date.now() - started < 60_000 && child.exitCode === null) {
    await new Promise(done => setTimeout(done, 100))
  }

  return { child, log: () => log }
}

// ---- the page calls `boot` ----
{
  const { child, log } = await feed(['-p', '5391'])

  try {
    const shell = await fetch('http://127.0.0.1:5391/').then(r => r.text(), () => '')
    ok('the shell calls the entry\'s `boot`', /import \{ boot \} from "\/@mod\/[a-z0-9]+\.mjs"; boot\(\)/.test(shell), shell || log())

    let chromium: Chromium | undefined

    try {
      chromium = (createRequire(join(MESH, 'package.json'))('@playwright/test') as { chromium: Chromium }).chromium
    } catch {
      console.log('skip  the browser case (no @playwright/test under mesh/)')
    }

    const launched = chromium ? await chromium.launch({ headless: true }).catch(() => undefined) : undefined

    if (launched) {
      try {
        const page = await launched.newPage()
        const said: string[] = []
        page.on('console', message => said.push(message.text?.() ?? ''))
        page.on('pageerror', error => said.push(`error: ${String(error)}`))
        await page.goto('http://127.0.0.1:5391/')
        await page.waitForTimeout(1500)
        ok('in a browser, the scaffold\'s `log` reaches the console', said.includes('hello from term') && !said.some(s => s.startsWith('error:')), said.join(' | '))
      } finally {
        await launched.close()
      }
    }
  } finally {
    child.kill()
  }
}

// ---- the port ----
{
  const holder = createServer()
  await new Promise<void>(done => holder.listen(5392, () => done()))

  try {
    const taken = spawnSync('node', [LINE, ...SERVE, '-p', '5392'], { cwd: project, encoding: 'utf8', timeout: 60_000, env: { ...process.env, NO_COLOR: '1' } })
    const said = `${taken.stdout}${taken.stderr}`
    ok('a `-p` that is taken is refused, naming `term halt -p`, exit 3', taken.status === 3 && /Port 5392 is in use/.test(said) && /term halt -p 5392/.test(said), `${taken.status} ${said}`)
  } finally {
    holder.close()
  }

  const defaultHolder = createServer()
  const defaultTaken = await new Promise<boolean>(done => defaultHolder.once('error', () => done(false)).listen(5173, () => done(true)))

  if (defaultTaken) {
    const { child, log } = await feed([])

    try {
      ok('without `-p`, a taken 5173 moves it to the next free port', /✓ start\s+http:\/\/localhost:51(7[4-9]|[89]\d)/.test(log()), log())
    } finally {
      child.kill()
      defaultHolder.close()
    }
  } else {
    console.log('skip  the default-port case (5173 is held by something else here)')
  }
}

// ---- ctrl-c before `start` still closes the run ----
// the handler was added after `start`, so an interrupt during the first build met node's default: exit 130 and no
// closing item (guides: commands/feed, 2026-10-05)
{
  const child = spawn('node', [LINE, ...SERVE, '-p', '5394'], { cwd: project, env: { ...process.env, NO_COLOR: '1' } })
  let log = ''
  child.stdout!.on('data', chunk => (log += String(chunk)))
  child.stderr!.on('data', chunk => (log += String(chunk)))
  const exited = new Promise<number | null>(done => child.once('exit', code => done(code)))
  const started = Date.now()

  // the opening item, `term 2.7.4 · development · browser`
  while (!/· browser/.test(log) && Date.now() - started < 30_000 && child.exitCode === null) {
    await new Promise(done => setTimeout(done, 20))
  }

  child.kill('SIGINT')
  const code = await exited
  ok('ctrl-c during the first build closes the run with its own item, exit 130', code === 130 && /(Not started|Stopped)/.test(log), `${code} ${log.slice(-300)}`)
}

console.log(`\nfeed: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
