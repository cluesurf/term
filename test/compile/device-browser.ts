// The device traits in a browser (native-dom-0012). The program is compiled for the `browser` env, so the public
// `view/device` reaches view/native/browser/device and its runtime, and run under Node against a stand-in `window`
// whose media queries the harness flips the way a browser does: the query's `matches` changes, then it fires `change`.
// The check is the signal's value, light before and dark after, and the other traits read from the queries and the
// window's width. That a written signal rewrites the view is held by render-native and toolkit-view; this holds that
// the browser writes it.
// Run: npx tsx test/compile/device-browser.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
const dir = mkdtempSync(join(tmpdir(), 'term-device-browser-'))

const PROGRAM = `load @term/site/code/view/device
  find device-trait

load @term/site/code/view/reactive
  find read-signal

task trait-text
  take name, like text
  like text
  save trait
    call device-trait
      read name
  send back
    call read-signal
      bind self, read trait

task scheme-line
  like text
  send back
    call trait-text
      text <color-scheme>

task traits-line
  like text
  save idiom
    call trait-text
      text <idiom>
  save width
    call trait-text
      text <width-class>
  save pointer
    call trait-text
      text <pointer>
  save motion
    call trait-text
      text <reduce-motion>
  send back, text <{{idiom}} {{width}} {{pointer}} {{motion}}>
`

// a window with the four queries the runtime asks, a laptop's: a fine pointer, 1280 wide, light, motion allowed
const STAND_IN = `const media: Record<string, { matches: boolean; listeners: (() => void)[] }> = {
  '(prefers-color-scheme: dark)': { matches: false, listeners: [] },
  '(prefers-reduced-motion: reduce)': { matches: false, listeners: [] },
  '(pointer: fine)': { matches: true, listeners: [] },
  '(pointer: coarse)': { matches: false, listeners: [] },
}
const standInResize: (() => void)[] = []
// the browser dom is in the program and reads the document when it loads; nothing here draws into it
;(globalThis as any).document = { documentElement: {}, body: {}, head: {} }
;(globalThis as any).window = {
  innerWidth: 1280,
  screen: { width: 1280, height: 800 },
  matchMedia(query: string) {
    const entry = media[query] ?? { matches: false, listeners: [] }
    return {
      get matches() { return entry.matches },
      addEventListener(_: string, run: () => void) { entry.listeners.push(run) },
    }
  },
  addEventListener(_: string, run: () => void) { standInResize.push(run) },
}
function flip(query: string, matches: boolean): void {
  media[query]!.matches = matches
  for (const run of media[query]!.listeners) run()
}
function narrow(width: number): void {
  ;(globalThis as any).window.innerWidth = width
  for (const run of standInResize) run()
}
`

const HARNESS = `
console.log(schemeLine())
console.log(traitsLine())
flip('(prefers-color-scheme: dark)', true)
console.log(schemeLine())
narrow(390)
console.log(traitsLine())
`

const entry = join(dir, 'device.tree')
writeFileSync(entry, PROGRAM)
const result = compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, 'browser'), env: 'browser' })
ok('the program compiles for the browser', result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => `${d.file}:${d.span?.start.line} ${d.message}`).join(' | '))

if (result.ok) {
  // the device runtime only: the browser dom's own shims ride along with the browser env (floating-ui among them), and
  // this program calls none of them
  const readRuntime = (file: string): string | undefined =>
    file.endsWith('/native-device.ts') && existsSync(file) ? readFileSync(file, 'utf8') : undefined
  const prelude = nativePrelude(result.program, 'browser', readRuntime, result.typescript)
  ok('the browser device runtime is in the prelude', prelude.includes('nativeDevice'))
  const file = join(dir, 'device.ts')
  writeFileSync(file, `${STAND_IN}\n${prelude}\n${result.typescript}\n${HARNESS}`)
  const run = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  const lines = run.stdout.split('\n').map(l => l.trim()).filter(Boolean)
  ok('it runs', run.status === 0, `exit ${run.status}: ${(run.stdout + run.stderr).slice(0, 600)}`)
  ok('light from the media query', lines[0] === 'light', JSON.stringify(lines[0]))
  ok('a fine pointer 1280 wide is a regular desktop', lines[1] === 'desktop regular fine no', JSON.stringify(lines[1]))
  // the same signal device-trait handed out first, written by the watcher the query's change event ran
  ok("the query's change event writes the signal", lines[2] === 'dark', JSON.stringify(lines[2]))
  ok('a resize to 390 makes the width class compact', lines[3] === 'desktop compact fine no', JSON.stringify(lines[3]))
}

console.log(`\ndevice-browser: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
