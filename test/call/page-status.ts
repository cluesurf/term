// A page answers with its own status, and its own title (note/term/gaps/plan.md, phase 7, "The web"). Until
// 2026-10-04 every path answered 200, an unknown one with an empty page, and a page's title broke its client bundle.
// Each case boots a real server with the built CLI and asks it over HTTP.
//
// Run: npx tsx test/call/page-status.ts (after `pnpm run make:line`)

import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const LINE = process.env.TERM_LINE ?? join(HERE, '../../host/line.js')
const MESH = join(HERE, '../../../../../../mesh')

type Page = {
  on: (event: 'pageerror', handler: (error: Error) => void) => void
  goto: (url: string) => Promise<unknown>
  evaluate: <T>(f: () => T) => Promise<T>
  waitForFunction: (f: string, arg?: unknown, options?: { timeout: number }) => Promise<unknown>
}
type Chromium = { launch: (o: { headless: boolean }) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> }

// Playwright from mesh/, as the other browser suites take it, or the reason it is not there
function chromium(): Chromium | string {
  try {
    return (createRequire(join(MESH, 'package.json'))('@playwright/test') as { chromium: Chromium }).chromium
  } catch (error) {
    return `no @playwright/test under mesh/: ${String(error).slice(0, 120)}`
  }
}

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

type Answer = { status: number; body: string }

// whether the last `serve` was answered on its first request, sent the moment `start` printed
let answeredAtStart = false

// boot `entry` in `dir` on `port`, ask each path once the server is up, run `visit` while it is, then stop it
async function serve(
  dir: string,
  entry: string,
  port: number,
  paths: string[],
  visit?: () => Promise<void>,
): Promise<{ answers: Answer[]; log: string }> {
  const child = spawn('node', [LINE, 'boot', entry, '--port', String(port)], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } })
  let log = ''
  child.stdout.on('data', chunk => (log += String(chunk)))
  child.stderr.on('data', chunk => (log += String(chunk)))

  const started = Date.now()

  while (!/✓ start/.test(log) && Date.now() - started < 60_000 && child.exitCode === null) {
    await new Promise(done => setTimeout(done, 100))
  }

  // `start` is printed once the server takes connections, so the first request on that line is answered. It was
  // printed at spawn until 2026-10-04, and this asked until it answered; it still does, so a failure here is the one
  // `ok` below and not every case after it
  answeredAtStart = await fetch(`http://127.0.0.1:${port}/base/__id`).then(() => true, () => false)

  while (Date.now() - started < 60_000 && child.exitCode === null) {
    const up = await fetch(`http://127.0.0.1:${port}/base/__id`).then(() => true, () => false)

    if (up) {
      break
    }

    await new Promise(done => setTimeout(done, 100))
  }

  const answers: Answer[] = []

  for (const path of paths) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}${path}`)
      answers.push({ status: response.status, body: await response.text() })
    } catch (error) {
      answers.push({ status: 0, body: String(error) })
    }
  }

  try {
    await visit?.()
  } finally {
    child.kill()
  }

  return { answers, log }
}

function project(name: string, entry: string, text: string): string {
  const dir = mkdtempSync(join(tmpdir(), `term-${name}-`))
  mkdirSync(join(dir, 'code'))
  writeFileSync(join(dir, 'deck.tree'), `deck ${name}\n  mark <0.0.1>\n`)
  writeFileSync(join(dir, entry), text)

  return dir
}

// ---- a hook table: an unknown path is 404, and the status does not reach the next request ----
{
  const dir = project(
    'hooks',
    'code/route.tree',
    `load @term/site/dom/dom
  find view

load @term/site/view/native/{platform}/host
  find host

view home
  take host, like view
  view h1, <Shelf>

hook /
  seed title, <Shelf>
  view home
`,
  )

  // the bundle `term boot` wrote, in a real browser: a popstate to `/` can only redraw and retitle the page if the
  // client took over, which no titled page could while `setTitle` was declared twice, and the page loads no CDN
  // module it does not use
  const browser = chromium()
  let seen = ''
  const visit = async (): Promise<void> => {
    if (typeof browser === 'string') {
      console.log(`skip  the client in a browser  (${browser})`)

      return
    }

    const launched = await browser.launch({ headless: true }).catch(error => {
      console.log(`skip  the client in a browser  (Chromium did not launch: ${String(error).slice(0, 160)})`)

      return undefined
    })

    if (!launched) {
      return
    }

    try {
      const page = await launched.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(String(error)))
      await page.goto('http://127.0.0.1:4971/books/dune')
      await page.evaluate(() => {
        history.pushState({}, '', '/')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForFunction("document.title === 'Shelf'", undefined, { timeout: 10_000 }).catch(() => undefined)
      const drawn = await page.evaluate(() => `${document.title}|${document.querySelector('h1')?.textContent ?? ''}|${document.querySelector('script[type=importmap]') ? 'map' : 'no map'}`)
      seen = `${drawn}|${errors.join(' ; ')}`
    } finally {
      await launched.close()
    }
  }

  const { answers, log } = await serve(dir, 'code/route.tree', 4971, ['/nope', '/'], visit)
  const [missing, home] = answers

  ok('`✓ start` prints once the server answers: a request sent on that line is answered', answeredAtStart)

  if (seen) {
    ok('in a browser, the client redraws and retitles the page on a popstate, with no error', seen === 'Shelf|Shelf|no map|', seen)
  }

  ok('a path no hook matches answers 404', missing?.status === 404, `${missing?.status} ${log.slice(0, 600)}`)
  ok('and the next request, a page that is there, answers 200', home?.status === 200, String(home?.status))
  ok('with the title its hook names', /<title>Shelf<\/title>/.test(home?.body ?? ''), home?.body.slice(0, 400))
  ok('and its client bundle built', /✓ build\s+client bundle/.test(log) && !/already been declared/.test(log), log.slice(0, 1200))

  const bundle = join(dir, 'build/boot.js')
  ok('and sets the title in the browser too', existsSync(bundle) && readFileSync(bundle, 'utf8').includes('setTitle("Shelf")'))
}

// ---- a route task: `set-status` in its own arm ----
{
  const dir = project(
    'routed',
    'code/boot.tree',
    `load @term/site/dom/dom
  find view

load @term/site/dom/page
  find set-title
  find set-status

load @term/site/view/native/{platform}/host
  find host

view home
  take host, like view
  view h1, <Shelf>

view missing
  take host, like view
  take path, like text
  view p
    <Nothing at >
    path

task route
  take host, like view
  take path, like text

  fork test, is-equal path, </>
    hold
      set-title <Shelf>
      home host
    miss
      set-status 404
      missing host, path

task boot
  take url, like text
  take port, like u16

  host(route, port)
`,
  )

  // a hand-written `boot` is called by the bundle's entry: before 2026-10-04 it was defined and never run, so nothing
  // took the page over in the browser
  const browser = chromium()
  let seen = ''
  const visit = async (): Promise<void> => {
    if (typeof browser === 'string') {
      return
    }

    const launched = await browser.launch({ headless: true }).catch(() => undefined)

    if (!launched) {
      return
    }

    try {
      const page = await launched.newPage()
      const errors: string[] = []
      page.on('pageerror', error => errors.push(String(error)))
      await page.goto('http://127.0.0.1:4972/')
      await page.evaluate(() => {
        history.pushState({}, '', '/elsewhere')
        dispatchEvent(new PopStateEvent('popstate'))
      })
      await page.waitForFunction("document.body.textContent.includes('Nothing at /elsewhere')", undefined, { timeout: 10_000 }).catch(() => undefined)
      const drawn = await page.evaluate(() => document.body.textContent?.replace(/\s+/g, ' ').trim() ?? '')
      seen = `${drawn}|${errors.join(' ; ')}`
    } finally {
      await launched.close()
    }
  }

  const { answers, log } = await serve(dir, 'code/boot.tree', 4972, ['/nope', '/'], visit)
  const [missing, home] = answers

  if (seen) {
    ok('in a browser, a hand-written boot takes the page over and draws the new path', seen === 'Nothing at /elsewhere|', seen)
  }

  ok('`set-status 404` in a route task answers 404', missing?.status === 404 && /Nothing at \/nope/.test(missing.body), `${missing?.status} ${log.slice(0, 600)}`)
  ok('and the page after it answers 200, titled', home?.status === 200 && /<title>Shelf<\/title>/.test(home.body), String(home?.status))
}

// ---- an API route: the response's headers reach the wire, and the request carries its headers and query ----
{
  const dir = project(
    'api',
    'code/boot.tree',
    `load @term/site/http/http
  find request
  find response
  find route
  find route-server

load @term/site/http/serve
  find serve

load @term/base/list
  find list
  find push

load @term/base/hash
  find hash
  find get, name hash-get
  find set

load @term/base/maybe
  find unwrap-or

task show-book
  take request, like request
  take params, like hash

  like response

  save id, unwrap-or(hash-get(params, <id>), <>)
  save fields, unwrap-or(hash-get(request/query, <fields>), <all>)
  save agent, unwrap-or(hash-get(request/headers, <user-agent>), <nobody>)
  save headers, make hash
  set headers, <content-type>, <application/json>

  back
    make response
      bind status, 200
      bind body, <{"id":"{id}","fields":"{fields}","agent":"{agent}"}>
      bind headers, headers

task boot
  take url, like text
  take port, like u16

  save routes, make list

  push routes
    make route
      bind method, <GET>
      bind path, </books/:id>
      bind handle, show-book
  serve route-server(routes), port
`,
  )
  writeFileSync(join(dir, 'deck.tree'), 'deck api\n  mark <0.0.1>\n  boot ./code/boot\n')

  const child = spawn('node', [LINE, 'boot', '--port', '4973'], { cwd: dir, env: { ...process.env, NO_COLOR: '1' } })
  let log = ''
  child.stdout.on('data', chunk => (log += String(chunk)))
  child.stderr.on('data', chunk => (log += String(chunk)))
  const started = Date.now()

  while (!/✓ start/.test(log) && Date.now() - started < 60_000 && child.exitCode === null) {
    await new Promise(done => setTimeout(done, 100))
  }

  try {
    const answer = await fetch('http://127.0.0.1:4973/books/7?fields=title', { headers: { 'user-agent': 'page-status' } }).catch(() => undefined)
    const body = answer ? await answer.text() : ''
    ok('a response\'s `content-type` header reaches the wire', answer?.headers.get('content-type') === 'application/json', `${answer?.headers.get('content-type')} ${log.slice(-400)}`)
    ok('and the handler read the query and a request header', body === '{"id":"7","fields":"title","agent":"page-status"}', body)
  } finally {
    child.kill()
  }
}

console.log(`\npage-status: ${pass} pass, ${fail} fail`)
process.exit(fail ? 1 : 0)
