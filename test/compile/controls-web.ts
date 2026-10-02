// Face's platform controls on the web (native-dom-0026): compiled for the `browser` env, each reaches its generic
// implementation, which is the browser's own control, and the value goes both ways through it, in headless Chromium.
//
//   slider   the browser's range input: the range's 40 is its value, a move the person makes (the value changed and
//            `input` fired, which is what a drag does) is written into the range, and writing the range moves it
//   select   the browser's `<select>`: the signal's `medium` is chosen, a choice the person makes (the value changed and
//            `change` fired) is written into the signal, and writing the signal moves it
//
// The same facts test/compile/toolkit-view.ts holds on AppKit, UIKit and Android.
// Skips, with the reason, when Playwright or its Chromium is absent. Run: npx tsx test/compile/controls-web.ts

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

type Page = {
  setContent: (html: string) => Promise<void>
  addScriptTag: (o: { content: string }) => Promise<unknown>
  evaluate: <T>(f: () => T) => Promise<T>
}
type Chromium = { launch: (o: { headless: boolean }) => Promise<{ newPage: () => Promise<Page>; close: () => Promise<void> }> }

const PROGRAM = `load @term/site/code/dom/dom
  find view
  find page-body

load @term/site/code/view/reactive
  find signal
  find write-signal

load @term/face/code/component/slider
  find slider

load @term/face/code/logic/range
  find make-range
  find range-value

load @term/face/code/component/select
  find select

load @term/face/code/component/input
  find input

load @term/face/code/component/dialog
  find dialog

load @term/face/code/logic/disclosure
  find make-disclosure
  find open-disclosure

load @term/site/code/view/reactive
  find make-signal
  find read-signal

load @term/base/code/list
  find list

form held-range
  note shared
  link range, like signal decimal

host held
  make held-range
    bind range
      call make-range
        bind start, code 40.0

form held-choice
  note shared
  link size, like signal text

task first-size
  like signal text
  send back
    call make-signal
      bind value, text <medium>

task first-greeting
  like signal text
  send back
    call make-signal
      bind value, text <hello>

form held-text
  note shared
  link greeting, like signal text

host written
  make held-text
    bind greeting, call first-greeting

task first-asking
  like signal boolean
  send back
    call make-disclosure
      bind start, false

form held-asking
  note shared
  link asking, like signal boolean

host shown
  make held-asking
    bind asking, call first-asking

view dialog-body
  take host, like view
  view span
    text <Sure?>

task open-dialog
  call open-disclosure
    bind self, read shown/asking

task greeting
  like text
  send back
    call read-signal
      bind self, read written/greeting

task set-greeting
  take to, like text
  call write-signal
    bind self, read written/greeting
    bind value, read to

# made right in the host: this failed until make-signal said like signal t (native-dom-0044)
host chosen
  make held-choice
    bind size
      call make-signal
        bind value, text <medium>

task size-names
  like list
    like text
  save names
    make list
  call push
    bind list, read names
    bind item, text <small>
  call push
    bind list, read names
    bind item, text <medium>
  call push
    bind list, read names
    bind item, text <large>
  send back, read names

task mount-page
  save body, call page-body
  call slider
    read body
    text <>
    read held/range
    code 0.0
    code 100.0
    code 0.5
  call select
    read body
    text <>
    read chosen/size
    call size-names
  call input
    read body
    text <>
    read written/greeting
    text <Your name>
  call dialog
    read body
    text <>
    read shown/asking
    text <Delete it?>
    read dialog-body

task size
  like text
  send back
    call read-signal
      bind self, read chosen/size

task set-size
  take to, like text
  call write-signal
    bind self, read chosen/size
    bind value, read to

task volume
  like decimal
  send back
    call range-value
      read held/range

task set-volume
  take to, like decimal
  call write-signal
    bind self, read held/range
    bind value, read to
`

// in a block of its own: the bundle's top level holds the program's own names (input, range, ...)
const HARNESS = `
{
mountPage()
const range = document.querySelector('input[type=range]')
const said = { shown: range.type + ' ' + range.value }
range.value = '37.5'
range.dispatchEvent(new Event('input'))
said.heard = String(volume())
setVolume(20)
said.moved = range.value
const picker = document.querySelector('select')
said.picked = picker.options.length + ' ' + picker.value
picker.value = 'large'
picker.dispatchEvent(new Event('change'))
said.chosen = size()
setSize('small')
said.repicked = picker.value
const field = document.querySelector('input[type=text]')
said.field = field.placeholder + ' ' + field.value
field.value = 'hello world'
field.dispatchEvent(new Event('input'))
said.typed = greeting()
setGreeting('bye')
said.rewritten = field.value
const frame = document.querySelector('[role=dialog]')
said.dialog = frame.getAttribute('aria-modal') + ' ' + frame.querySelector('h2').textContent + ' ' + frame.querySelector('span').textContent
said.hidden = getComputedStyle(frame).display
openDialog()
said.showing = getComputedStyle(frame).display
window.__said = said
}
`

async function main(): Promise<void> {
  let chromium: Chromium

  try {
    chromium = (createRequire(join(MESH, 'package.json'))('@playwright/test') as { chromium: Chromium }).chromium
  } catch (error) {
    console.log(`skip  controls-web  (no @playwright/test under mesh/: ${String(error).slice(0, 120)})`)

    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'term-controls-web-'))
  const entry = join(dir, 'slider.tree')
  writeFileSync(entry, PROGRAM)
  const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' })
  ok('the controls compile for the browser', result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => `${d.file}:${(d.span?.start.line ?? 0) + 1} ${d.message}`).join(' | '))

  if (!result.ok) {
    return
  }

  ok('the browser gets the generic slider, a range input', result.typescript.includes('"range"'))
  const readRuntime = (file: string): string | undefined =>
    !file.endsWith('/position.ts') && existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const prelude = nativePrelude(result.program, 'browser', readRuntime, result.typescript)
  const source = join(dir, 'slider.ts')
  writeFileSync(source, `${prelude}\n${result.typescript}\n${HARNESS}`)
  const bundle = await build({ entryPoints: [source], bundle: true, write: false, format: 'iife', platform: 'browser', logLevel: 'silent' })

  const launched = await chromium.launch({ headless: true }).catch(error => {
    console.log(`skip  controls-web  (Chromium did not launch: ${String(error).slice(0, 160)})`)

    return undefined
  })

  if (!launched) {
    return
  }

  try {
    const page = await launched.newPage()
    await page.setContent('<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>')
    await page.addScriptTag({ content: bundle.outputFiles[0]!.text })
    const said = await page.evaluate(() => (window as unknown as { __said: Record<string, string> }).__said)
    ok("the slider is the browser's range input, showing the range's 40", said.shown === 'range 40', String(said.shown))
    ok('a move to 37.5 made on the input, half a step, is written into the range', said.heard === '37.5', String(said.heard))
    ok('the range written to 20 moves the input', said.moved === '20', String(said.moved))
    ok("the select is the browser's own, three options, showing the signal's medium", said.picked === '3 medium', String(said.picked))
    ok('large chosen on it is written into the signal', said.chosen === 'large', String(said.chosen))
    ok('the signal written to small moves it', said.repicked === 'small', String(said.repicked))
    ok("the input is the browser's own text field, its placeholder set, showing the signal's hello", said.field === 'Your name hello', String(said.field))
    ok('hello world typed into it is written into the signal', said.typed === 'hello world', String(said.typed))
    ok('the signal written to bye shows in it', said.rewritten === 'bye', String(said.rewritten))
    ok('the dialog is a modal dialog holding its title and content', said.dialog === 'true Delete it? Sure?', String(said.dialog))
    ok('it is hidden while the disclosure is closed', said.hidden === 'none', String(said.hidden))
    ok('and shown when it opens', said.showing === 'block', String(said.showing))
  } finally {
    await launched.close()
  }
}

await main()

console.log(`\ncontrols-web: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
