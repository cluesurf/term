// The vocabulary's controls in the terminal (deck/site/code/dom/native/terminal/paint.tree and input.tree): FACE's
// switch, slider, select, dialog and scroll, as their generic implementations build them from plain elements, painted
// into the cell grid and driven by keys. Each EXPECTED screen is worked out by hand from the cell grid column of
// note/term/view/11-vocabulary.md: a toggle `[ ]` or `[x]` with its label, a range a bar of 10 cells and its value, a
// choice its label and `▾`, a dialog a bordered box over its title and content, a scroll a column of what it holds. It
// runs on TypeScript, Rust, Swift and Kotlin, and every backend must draw the same cells.
// Run: npx tsx test/view/terminal-words.ts   (TERMINAL_ONLY=rust for one backend)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'
import { BACKENDS, runOn } from '../compile/shared/run-on'

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

const WIDTH = 24
const HEIGHT = 10

// the dialog is a box across the column's 24 cells: its corners, 22 cells of edge, and inside them the title and the
// content, the right edge after the padding of blanks
const BOX = ['┌──────────────────────┐', '│Saved                 │', '│ok                    │', '└──────────────────────┘']

// nothing focused: the toggle off, the range at 40 of 0 to 100 (4 cells of 10), the choice at `medium`
const BEFORE = ['[ ] wifi', '[####------] 40', '[medium ▾]', ...BOX, 'one', 'two', ''].join('\n')

// tab and space flip the toggle on; tab and right step the range by 10, to 50; tab and right move the choice to the
// option after `medium`, `large`, which keeps focus
const AFTER = ['[x] wifi', '[#####-----] 50', '>large ▾<', ...BOX, 'one', 'two', ''].join('\n')

const KEYS = ['tab', 'space', 'tab', 'right', 'tab', 'right']

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/terminal/dom
  find create-element
  find paint-screen
  find press-key

load @term/face/component/switch
  find switch

load @term/face/component/slider
  find slider

load @term/face/component/select
  find select

load @term/face/component/dialog
  find dialog

load @term/face/component/scroll
  find scroll

load @term/face/logic/disclosure
  find make-disclosure

load @term/face/logic/range
  find make-range

load @term/base/code/list
  find list
  find push

task make-sizes
  like list
    like text
  save out
    make list
  call push
    bind list, read out
    bind item, text <small>
  call push
    bind list, read out
    bind item, text <medium>
  call push
    bind list, read out
    bind item, text <large>
  send back, read out

# what the dialog holds, built into the host it is handed
task fill-notice
  take host, like view
  call append
    read host
    call make-text
      text <ok>

view panel
  take host, like view
  save wifi
    call make-disclosure
      bind start, false
  save volume
    call make-range
      bind start, code 40.0
  save size
    call make-signal
      bind value, text <medium>
  save notice
    call make-disclosure
      bind start, true
  view div
    bind style, text <display: flex; flex-direction: column>
    view switch
      bind class, text <>
      bind control, read wifi
      bind label, text <wifi>
    view slider
      bind class, text <>
      bind control, read volume
      bind min, code 0.0
      bind max, code 100.0
      bind step, code 10.0
      bind label, text <volume>
    view select
      bind class, text <>
      bind control, read size
      bind options, call make-sizes
      bind label, text <size>
    view dialog
      bind class, text <>
      bind control, read notice
      bind title, text <Saved>
      bind content, read fill-notice
    view scroll
      view p
        text <one>
      view p
        text <two>

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call panel
    read root
  save before
    call paint-screen
      read root
      code ${WIDTH}
      code ${HEIGHT}
${KEYS.map(key => `  call press-key\n    read root\n    text <${key}>`).join('\n')}
  save after
    call paint-screen
      read root
      code ${WIDTH}
      code ${HEIGHT}
  send back, text <{before}|{after}>
`

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/terminal/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-words-'))
const only = process.env.TERMINAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'words' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: face's controls compile, build and run against the terminal host`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const [before, after] = ran.output.split('|')
    ok(`${backend}: a toggle, a range, a choice, an open dialog and a scroll, drawn`, before === BEFORE, `got ${JSON.stringify(before)}`)
    ok(`${backend}: space flips the toggle, right steps the range and moves the choice`, after === AFTER, `got ${JSON.stringify(after)}`)
  }
}

console.log(`\nterminal-words: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
