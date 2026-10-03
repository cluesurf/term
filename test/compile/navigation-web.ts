// The navigation contract in a real browser (native-navigation-0001): the browser host, refitted onto the contract,
// in headless Chromium at a real origin (History refuses pushState on about:blank, so the page is served from
// http://term.test/ by Playwright's request routing). The app's own `navigate` must push the browser's History and draw
// the new place; the browser's back must reach the contract through `follow-address` and draw the place before; a
// same-origin link click must move it the same way. One effect draws all three.
// Skips, with the reason, when Playwright or its Chromium is absent. Run: npx tsx test/compile/navigation-web.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'

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

const ROOT = process.cwd()
const MESH = join(ROOT, '../../../../mesh')

type Route = { fulfill: (o: { contentType: string; body: string }) => Promise<void> }
type Page = {
  route: (pattern: string, handler: (route: Route) => Promise<void>) => Promise<void>
  goto: (url: string) => Promise<unknown>
  evaluate: <T>(f: () => T) => Promise<T>
  waitForFunction: (f: string) => Promise<unknown>
  click: (selector: string) => Promise<void>
}
type Chromium = { launch: (o: { headless: boolean }) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> }

const PROGRAM = `load @term/site/code/dom/dom
  find view
  find create-element
  find create-text
  find set-attribute
  find append

load @term/site/code/view/native/browser/host
  find host

load @term/site/code/view/navigation
  find navigate

# a place drawn: its path as text, and a same-origin link to /c
task draw
  take host, like view
  take path, like text
  save here
    call create-element
      text <p>
  call set-attribute
    read here
    text <id>
    text <here>
  call append
    read here
    call create-text
      read path
  call append
    read host
    read here
  save link
    call create-element
      text <a>
  call set-attribute
    read link
    text <href>
    text </c>
  call set-attribute
    read link
    text <id>
    text <to-c>
  call append
    read link
    call create-text
      text <to c>
  call append
    read host
    read link

task start
  call host
    read draw
    code 0

task go-to-b
  call navigate
    text </b>
`

const HARNESS = `
{
window.__start = start
window.__goToB = goToB
}
`

async function main(): Promise<void> {
  let chromium: Chromium

  try {
    chromium = (createRequire(join(MESH, 'package.json'))('@playwright/test') as { chromium: Chromium }).chromium
  } catch (error) {
    console.log(`skip  navigation-web  (no @playwright/test under mesh/: ${String(error).slice(0, 120)})`)

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-navigation-web-'))
  const entry = join(dir, 'navigation.tree')
  writeFileSync(entry, PROGRAM)
  const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' })
  ok('the app compiles for the browser', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 4).join(' | '))

  if (!result.ok) {
    return
  }

  // the positioning runtime imports @floating-ui/dom, which this page places nothing with: left out, as controls-web does
  const readRuntime = (file: string): string | undefined =>
    !file.endsWith('/position.ts') && existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const source = join(dir, 'navigation.ts')
  writeFileSync(source, `${nativePrelude(result.program, 'browser', readRuntime, result.typescript)}\n${result.typescript}\n${HARNESS}`)
  const bundle = await build({ entryPoints: [source], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })
  const html = `<!doctype html><html><head><meta charset="utf-8"></head><body></body><script>${bundle.outputFiles[0]!.text}</script></html>`

  const launched = await chromium.launch({ headless: true }).catch(error => {
    console.log(`skip  navigation-web  (Chromium did not launch: ${String(error).slice(0, 160)})`)

    return undefined
  })

  if (!launched) {
    return
  }

  try {
    const page = await launched.newPage()
    // every path of the origin answers the one page, as a single-page app's server does
    await page.route('http://term.test/**', route => route.fulfill({ contentType: 'text/html', body: html }))
    await page.goto('http://term.test/')

    const here = () => page.evaluate(() => `${location.pathname} ${document.getElementById('here')?.textContent ?? ''} ${history.length}`)

    await page.evaluate(() => (window as unknown as { __start: () => void }).__start())
    const first = await here()
    ok('the page draws where the browser is: /', first.startsWith('/ /'), first)

    await page.evaluate(() => (window as unknown as { __goToB: () => void }).__goToB())
    const pushed = await here()
    ok("the app's navigate pushes History and draws /b", pushed.startsWith('/b /b') && Number(pushed.split(' ')[2]) >= 2, pushed)

    await page.evaluate(() => history.back())
    await page.waitForFunction("document.getElementById('here')?.textContent === '/'")
    const back = await here()
    ok("the browser's back reaches the contract and draws / again", back.startsWith('/ /'), back)

    await page.click('#to-c')
    await page.waitForFunction("document.getElementById('here')?.textContent === '/c'")
    const clicked = await here()
    ok('a same-origin link moves it the same way, to /c, with no reload', clicked.startsWith('/c /c'), clicked)
  } finally {
    await launched.close()
  }
}

await main()

console.log(`\nnavigation-web: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
