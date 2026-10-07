// The terminal host (terminal-target-0002, deck/site/code/dom/native/terminal): the render runtime building a retained
// tree in a terminal's host, and that tree painted into the cell grid. The program is a view written in the DSL with
// the CSS words face places (a flex row with a grower, a divider, a live `fork`), its dom pinned to the terminal host,
// and the screen painted before and after three clicks on its button. Each EXPECTED screen is worked out by hand from
// note/term/view/11-vocabulary.md (a cell 8 points wide, a column stretching its children, growers taking the free
// cells, a button drawn `[ label ]`), never read from the painter's output. Every program runs on TypeScript, Rust,
// Swift and Kotlin (terminal-target-0004), and each must draw the same cells.
// Run: npx tsx test/view/terminal-host.ts   (TERMINAL_ONLY=rust for one backend)

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

const WIDTH = 16
const HEIGHT = 4

// 16 cells: `count` (5), a 1 cell gap, the grower (the 4 free cells), a 1 cell gap, `[ 0 ]` (5). The divider is a line
// across the stretched column, and the fork's branch is under it. Rows end where their last drawn cell does, and the
// grid's fourth row is empty, so the screen ends in a line break
const BEFORE = 'count      [ 0 ]\n────────────────\nfew\n'
// three clicks: the button's dynamic text is 3, and the fork has swapped its branch (count above 2)
const AFTER = 'count      [ 3 ]\n────────────────\nmany\n'

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event
  find show

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/terminal/dom
  find create-element
  find child-at
  find fire
  find paint-screen

task shown
  take count, like signal number
  like text
  save value
    call read-signal
      bind self, read count
  send back, text <{value}>

view screen
  take host, like view
  save count
    call make-signal
      bind value, code 0
  view div
    bind style, text <display: flex; flex-direction: row; gap: 8px>
    view span
      text <count>
    view div
      bind style, text <flex-grow: 1>
    view button
      seed click
        call write-signal
          bind self, read count
          bind value
            call add
              call read-signal
                bind self, read count
              code 1
      read
        call shown
          read count
  view hr
  fork test
    hook test
      call is-above
        call read-signal
          bind self, read count
        code 2
    hook hold
      view p
        text <many>
    hook miss
      view p
        text <few>

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call screen
    read root
  save before
    call paint-screen
      read root
      code ${WIDTH}
      code ${HEIGHT}
  save row
    call child-at
      read root
      code 0
  save button
    call child-at
      read row
      code 2
  walk size
    bind base, code 0
    bind head, code 3
    hook next
      take site, name step
      call fire
        read button
        text <click>
  save after
    call paint-screen
      read root
      code ${WIDTH}
      code ${HEIGHT}
  send back, text <{before}|{after}>
`

// The second screen is built from FACE's components, so the painter reads the style words face writes rather than ones
// written for it: a stack (a column, stretch, 16 points of padding: 2 cells across, 1 down), a frame 64 points wide
// (8 cells) around a text that wraps there, a divider, a `walk` over a list signal, and a button that drops an item.
// 16 cells across: inside the padding 12, the frame keeps its 8, the divider and the rest stretch to 12.
const LIST_WIDTH = 16
const LIST_HEIGHT = 10
const LIST_BEFORE = '\n  fruit\n  list\n  here\n  ────────────\n  apple\n  banana\n  [ drop ]\n\n'
// one item fewer, and the button still under the list: a walk keeps its place among its siblings
const LIST_AFTER = '\n  fruit\n  list\n  here\n  ────────────\n  apple\n  [ drop ]\n\n\n'

const LIST_PROGRAM = `load @term/site/code/view/reactive
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
  find child-at
  find child-count
  find fire
  find paint-screen

load @term/face/code/component/stack
  find stack

load @term/face/code/component/frame
  find frame

load @term/face/code/component/divider
  find divider

load @term/base/code/list
  find list
  find push

task make-fruit
  take both, like boolean
  like list
    like text
  save out
    make list
  call push
    bind list, read out
    bind item, text <apple>
  fork test
    hook test
      read both
    hook hold
      call push
        bind list, read out
        bind item, text <banana>
  send back, read out

task current-fruit
  take items, like signal
  like list
    like text
  send back
    call read-signal
      bind self, read items

view inventory
  take host, like view
  save items
    call make-signal
      bind value
        call make-fruit
          bind both, true
  view stack
    bind direction, text <column>
    bind gap, code 0
    bind align, text <stretch>
    bind justify, text <start>
    bind padding, code 16
    view frame
      bind width, code 64
      bind height, code 0
      bind min-width, code 0
      bind max-width, code 0
      bind min-height, code 0
      bind max-height, code 0
      view span
        text <fruit list here>
    view divider
    walk list, call current-fruit(read items)
      hook next
        take site, name item
        view p
          read item
    view button
      seed click
        call write-signal
          bind self, read items
          bind value
            call make-fruit
              bind both, false
      text <drop>

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call inventory
    read root
  save before
    call paint-screen
      read root
      code ${LIST_WIDTH}
      code ${LIST_HEIGHT}
  save shell
    call child-at
      read root
      code 0
  # the button is the stack's last child, wherever the runtime's own markers put the others
  save last
    call subtract
      call child-count
        read shell
      code 1
  call fire
    call child-at
      read shell
      read last
    text <click>
  save after
    call paint-screen
      read root
      code ${LIST_WIDTH}
      code ${LIST_HEIGHT}
  send back, text <{before}|{after}>
`

// the render runtime's dom is the terminal host, whatever env compiles it
function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/terminal/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-host-'))
// TERMINAL_ONLY=rust (or typescript, swift, kotlin) runs one backend; the gate runs each on its own line
const only = process.env.TERMINAL_ONLY ?? ''

// compile one program against the terminal host on every backend, run it, and hold its two paints to the screens worked
// out by hand. The host and the painter are Term, so every backend must draw the same cells
function screens(one: { name: string; program: string; before: string; after: string; first: string; second: string }): void {
  for (const backend of BACKENDS.filter(b => !only || b === only)) {
    const ran = runOn({ backend, program: one.program, resolve: pinned, dir, name: one.name })
    const label = `${backend} ${one.name}`

    if (ran.form === 'skipped') {
      console.log(`skip  ${label}: ${ran.reason}`)
      continue
    }

    ok(`${label}: compiles, builds and runs against the terminal host`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

    if (ran.form === 'ran') {
      const [before, after] = ran.output.split('|')
      ok(`${label}: ${one.first}`, before === one.before, `got ${JSON.stringify(before)}`)
      ok(`${label}: ${one.second}`, after === one.after, `got ${JSON.stringify(after)}`)
    }
  }
}

screens({
  name: 'counter',
  program: PROGRAM,
  before: BEFORE,
  after: AFTER,
  first: 'a row with a grower, a divider, the fork\'s branch',
  second: 'after three clicks the button reads 3 and the fork swapped',
})

screens({
  name: 'inventory',
  program: LIST_PROGRAM,
  before: LIST_BEFORE,
  after: LIST_AFTER,
  first: 'face\'s stack, frame and divider, and a walk of two items',
  second: 'an item dropped, the button still under the list',
})

console.log(`\nterminal-host: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
