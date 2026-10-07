// Keys into the terminal host (terminal-target-0003, deck/site/code/dom/native/terminal/input.tree and focus.tree): a
// note form driven by keys alone. Tab moves focus, characters edit the focused field and fire its `input`, enter on
// the focused button fires its `click`, and the painter draws the focus ring. Each EXPECTED screen is worked out by
// hand from the rules in input.tree and paint.tree (an unfocused field `[value ]` or its placeholder, a focused one
// `>value█<` at the same width, a button `[ add ]` or `> add <`), never read from the painter's output. It runs on
// TypeScript, Rust, Swift and Kotlin (terminal-target-0004), and every backend must answer every key the same way.
// Run: npx tsx test/view/terminal-input.ts   (TERMINAL_ONLY=rust for one backend)

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

const WIDTH = 20
const HEIGHT = 4

// each step: what was pressed, and the screen after it. A row is the field (7 cells), a 1 cell gap, the button (7);
// the notes are under it, and the screen's empty rows end in line breaks
const STEPS: { did: string; keys: string[]; want: string }[] = [
  { did: 'nothing focused: the field shows its placeholder', keys: [], want: '[note ] [ add ]\n\n\n' },
  { did: 'tab focuses the field, and two characters type into it', keys: ['tab', 'h', 'i'], want: '>hi█< [ add ]\n\n\n' },
  { did: 'tab to the button and enter: the note is added and the field cleared', keys: ['tab', 'enter'], want: '[note ] > add <\nhi\n\n' },
  { did: 'shift-tab back to the field, a character, then backspace', keys: ['shift-tab', 'o', 'k', 'backspace'], want: '>o█< [ add ]\nhi\n\n' },
  { did: 'tab wraps past the last control to the first', keys: ['tab', 'tab'], want: '>o█< [ add ]\nhi\n\n' },
]

const presses = STEPS.map((step, i) => {
  const keys = step.keys.map(key => `  call press-key\n    read root\n    text <${key}>`).join('\n')

  return `${keys}\n  save paint-${i}\n    call paint-screen\n      read root\n      code ${WIDTH}\n      code ${HEIGHT}`
}).join('\n')

const joined = STEPS.map((_, i) => `{paint-${i}}`).join('|')

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event
  find render-each

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/terminal/dom
  find create-element
  find get-value
  find set-value
  find paint-screen
  find press-key

load @term/base/code/list
  find list
  find push

task make-notes
  like list
    like text
  send back
    make list

task add-note
  take items
    like list
      like text
  take note, like text
  like list
    like text
  save out, call make-notes
  walk list, read items
    hook next
      take site, name item
      call push
        bind list, read out
        bind item, read item
  call push
    bind list, read out
    bind item, read note
  send back, read out

task current-notes
  take items, like signal
  like list
    like text
  send back
    call read-signal
      bind self, read items

view notes
  take host, like view
  save draft
    call make-signal
      bind value, text <>
  save items
    call make-signal
      bind value, call make-notes
  view div
    bind style, text <display: flex; flex-direction: row; gap: 8px>
    view input
      name field
      bind placeholder, text <note>
      seed input
        call write-signal
          bind self, read draft
          bind value
            call get-value
              read field
    view button
      seed click
        call write-signal
          bind self, read items
          bind value
            call add-note
              call read-signal
                bind self, read items
              call read-signal
                bind self, read draft
        call set-value
          read field
          text <>
        call write-signal
          bind self, read draft
          bind value, text <>
      text <add>
  walk list, call current-notes(read items)
    hook next
      take site, name item
      view p
        read item

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call notes
    read root
${presses}
  send back, text <${joined}>
`

// the render runtime's dom is the terminal host, whatever env compiles it
function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/terminal/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-input-'))
// TERMINAL_ONLY=rust (or typescript, swift, kotlin) runs one backend; the gate runs each on its own line
const only = process.env.TERMINAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'notes' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: the note form compiles, builds and runs against the terminal host`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const paints = ran.output.split('|')

    for (const [i, step] of STEPS.entries()) {
      ok(`${backend}: ${step.did}`, paints[i] === step.want, `got ${JSON.stringify(paints[i])}, want ${JSON.stringify(step.want)}`)
    }
  }
}

console.log(`\nterminal-input: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
