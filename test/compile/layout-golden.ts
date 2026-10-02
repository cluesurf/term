// The layout words on the WEB, as the golden the native hosts are held to (native-dom-0027). The same four rows
// test/compile/toolkit-view.ts reads back from AppKit, UIKit and Android views are compiled here for the `browser`
// env, through the real browser dom, bundled, and drawn by headless Chromium; each row's frame and its two children's
// come from getBoundingClientRect. The checks are the SAME relationship checks the native test makes (order, edges,
// which child grew, stretch, height), imported from one place, so a layout word that means something different on one
// platform fails on that platform and not on the others.
// Skips, with the reason, when Playwright or its Chromium is absent. Run: npx tsx test/compile/layout-golden.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import { LAYOUT_LABELS, LAYOUT_ROWS, judgeLayout } from './shared/layout-rows'

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

type Chromium = { launch: (o: { headless: boolean }) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> }
type Page = {
  setContent: (html: string) => Promise<void>
  addScriptTag: (o: { content: string }) => Promise<unknown>
  evaluate: <T>(f: () => T) => Promise<T>
}

function chromium(): Chromium | string {
  try {
    const require = createRequire(join(MESH, 'package.json'))

    return (require('@playwright/test') as { chromium: Chromium }).chromium
  } catch (error) {
    return `no @playwright/test under mesh/ (${String(error).slice(0, 120)})`
  }
}

const PROGRAM = `load @term/site/code/dom/dom
  find view
  find page-body

${LAYOUT_ROWS}

task main
  save body, call page-body
${LAYOUT_LABELS.map(([, view]) => `  call ${view}\n    read body\n`).join('')}`

// each row's frame and its first two children's, in the native test's own line format
const MEASURE = `
main()
const frame = (el) => { const r = el.getBoundingClientRect(); return [r.left, r.top, r.width, r.height].map(Math.round).join(',') }
const rows = [...document.body.children].filter(el => el.tagName === 'DIV')
window.__said = ${JSON.stringify(LAYOUT_LABELS.map(([label]) => label))}.map((label, i) => {
  const row = rows[i]
  return 'rows ' + label + ' ' + frame(row) + ' ' + frame(row.children[0]) + ' ' + frame(row.children[1])
}).join('\\n')
`

async function main(): Promise<void> {
  const browser = chromium()

  if (typeof browser === 'string') {
    console.log(`skip  layout-golden  (${browser})`)

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-layout-golden-'))
  const entry = join(dir, 'rows.tree')
  writeFileSync(entry, PROGRAM)
  const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' })
  ok('the rows compile for the browser', result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))

  if (!result.ok) {
    return
  }

  // the dom's shims, except floating-ui's `position`, which this page never calls and whose package is not installed here
  const readRuntime = (file: string): string | undefined =>
    !file.endsWith('/position.ts') && existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const prelude = nativePrelude(result.program, 'browser', readRuntime, result.typescript)
  const source = join(dir, 'rows.ts')
  writeFileSync(source, `${prelude}\n${result.typescript}\n${MEASURE}`)
  const bundle = await build({ entryPoints: [source], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })
  const script = bundle.outputFiles[0]!.text

  let launched: Awaited<ReturnType<Chromium['launch']>>

  try {
    launched = await browser.launch({ headless: true })
  } catch (error) {
    console.log(`skip  layout-golden  (Chromium did not launch: ${String(error).slice(0, 160)})`)

    return
  }

  try {
    const page = await launched.newPage()
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    await page.addScriptTag({ content: script })
    const said = await page.evaluate(() => (window as unknown as { __said: string }).__said)
    console.log(said.split('\n').map(line => `      ${line}`).join('\n'))

    for (const [name, passed, info] of judgeLayout(said)) {
      ok(`browser: ${name}`, passed, info)
    }
  } finally {
    await launched.close()
  }
}

await main()

console.log(`\nlayout-golden: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
