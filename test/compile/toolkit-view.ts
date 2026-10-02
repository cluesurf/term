// The dom on the platform's own toolkit (native-dom-0005, 0006): ONE Term program, rendered by the Solid-style runtime
// into real AppKit views on macOS, real UIKit views on the iOS simulator and real Android views on the emulator, with no
// WebView and no JavaScript engine. The program opens a window, renders a counter written in the `view` DSL, presses
// its button with the platform's own click (performClick, sendActions, performClick), and prints the tree as read back
// FROM THE VIEWS (the button's title as the toolkit draws it), then writes a PNG of the screen.
//
// The check is the printed tree: `low` at five presses and `high` at eleven, the button titled with the count. Each
// PNG goes to SNAPSHOT, SNAPSHOT_IOS or SNAPSHOT_ANDROID when set, which is how the screenshots in
// note/term/project/native-dom/ are made. TOOLKIT_ONLY=macos (or ios, android) runs one platform.
// Run: npx tsx test/compile/toolkit-view.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'
import { compileLookTable, styleTableText } from '@term/make/code/compile/look-table'
import { LAYOUT_LABELS, LAYOUT_ROWS, judgeLayout } from './shared/layout-rows'
import {
  androidDevice,
  androidTools,
  assembleApk,
  assembleIosBundle,
  buildAndroidProgram,
  simulator,
} from '@term/call/code/cask'

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
const dir = mkdtempSync(join(tmpdir(), 'term-toolkit-view-'))

// native-dom-0008: face's own theme, compiled to the style table the app hands its host, light scheme
const THEME = join(ROOT, 'deck/face/code/style/theme.tree')
const STYLE_TABLE = styleTableText(compileLookTable({ file: THEME, text: readFileSync(THEME, 'utf8') }))
const STYLE_TABLE_DARK = styleTableText(compileLookTable({ file: THEME, text: readFileSync(THEME, 'utf8') }, { scheme: 'dark' }))

// what the platform must draw for it, read back off the views: the panel's fill, edge, corners and the text color its
// children inherit, the overlay's opacity closed then open, a label's font, a fill set inline that the class's row does
// not override while its edge still applies, and a kbd's fill gone once its class is removed
const WANT_STYLES = 'styles #fafafa 1px #e4e4e7 8px #18181b 0 1 14px 500 #102030 1px #e4e4e7 #f4f4f5 none'

// native-dom-0048: the same panel once the platform turns the device dark, restyled from the dark table: the theme's
// dark surface and the dark text color its child inherits
const WANT_DARK_STYLES = 'styles dark #09090b #f4f4f5'
const png = process.env.SNAPSHOT ?? join(dir, 'window.png')

const WANT = [
  '<main><button>5</button><span>low</span><switch checked="false"></switch><div><button>a</button><button>bb</button></div></main>',
  '<main><button>11</button><span>high</span><switch checked="true"></switch><div><button>a</button><button>bb</button></div></main>',
]

// every layout row mounted on the root, then each one's frames said: the rows are the root's children 4 onward
const LAYOUT_CALLS =
  LAYOUT_LABELS.map(([, view]) => `      call ${view}\n        read root\n`).join('') +
  LAYOUT_LABELS.map(
    ([label], i) => `      call say-row\n        text <${label}>\n        call child-at\n          read root\n          code ${4 + i}\n`,
  ).join('')

// the dom is loaded the way an app loads it, through the public path, so the `macos` env picks the Apple host
const program = (shot: string): string => `load @term/site/code/view/reactive
  find make-effect
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find element
  find text
  find dynamic
  find event
  find show

load @term/site/code/dom/dom
  find view
  find append
  find add-class
  find remove-class
  find set-attribute
  find set-style
  find create-text

load @term/site/code/dom/style
  find use-styles

# the switch the author writes once; on these three platforms the build picks the platform's own control
load @term/face/code/component/switch
  find switch

load @term/face/code/logic/disclosure
  find make-disclosure

# the slider the author writes once (native-dom-0026); here NSSlider, UISlider or a SeekBar
load @term/face/code/component/slider
  find slider

load @term/face/code/logic/range
  find make-range
  find range-value

# the select the author writes once (native-dom-0026); here NSPopUpButton, a UIButton menu or a Spinner
load @term/face/code/component/select
  find select

# the input the author writes once (native-dom-0026); here NSTextField, UITextField or EditText
load @term/face/code/component/input
  find input

# the dialog the author writes once (native-dom-0026); here an NSPanel sheet, a page sheet or an android.app.Dialog
load @term/face/code/component/dialog
  find dialog

load @term/face/code/logic/disclosure
  find disclosure-open
  find open-disclosure

load @term/base/code/list
  find list

load @term/site/code/view/device
  find device-trait

load @term/site/code/view/native/toolkit/device
  find change-trait
  find turn-device

load @term/site/code/dom/native/toolkit/dom
  find create-element
  find frame-of
  find style-of
  find unsupported-styles
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find press
  find slide
  find choose
  find type-text
  find dismiss
  find later
  find child-at
  find serialize
  find snapshot
  find say

task shown
  take count, like signal number
  like text
  save value
    call read-signal
      bind self, read count
  send back, text <{{value}}>

view tally
  take host, like view
  save count
    call make-signal
      bind value, code 0
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
  fork test
    hook test
      call is-above
        call read-signal
          bind self, read count
        code 10
    hook hold
      view span
        text <high>
    hook miss
      view span
        text <low>

# a row laid out by the platform's own stack: direction, gap, alignment and padding, written once as CSS words
view sample-row
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; gap: 12px; align-items: center; padding: 8px>
    view button
      text <a>
    view button
      text <bb>

# a device trait as a signal (native-dom-0012): the span reads the platform's color scheme and is rewritten when it
# changes
task trait-text
  take name, like text
  like text
  save trait
    call device-trait
      read name
  send back
    call read-signal
      bind self, read trait

view theme
  take host, like view
  view span
    read
      call trait-text
        text <color-scheme>

# native-dom-0035: how many times each span's text was computed, so a turn can show that only the one reading the
# width ran again
form runs
  note shared
  link width, like number
  link scheme, like number

host counted
  make runs
    bind width, code 0
    bind scheme, code 0

task counted-width
  like text
  save counted/width
    call add
      read counted/width
      code 1
  send back
    call trait-text
      text <width-class>

task counted-scheme
  like text
  save counted/scheme
    call add
      read counted/scheme
      code 1
  send back
    call trait-text
      text <color-scheme>

view turn-watch
  take host, like view
  view span
    read
      call counted-width
  view span
    read
      call counted-scheme

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
  save scale
    call trait-text
      text <text-scale>
  send back, text <traits {{idiom}} {{width}} {{pointer}} {{motion}} {{scale}}>

# the layout words native-dom-0027 holds, each a row of two buttons whose frames are read back from the views. The
# same rows layout-golden.ts draws in Chromium (test/compile/shared/layout-rows.ts)
${LAYOUT_ROWS}
# what the dialog holds: drawn into it by the dialog, wherever the platform presents it
view dialog-body
  take host, like view
  view span
    text <Sure?>

# the select's choices, made at the top level: a list made inside a closure reaches Swift untyped (native-dom-0021)
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

# a row and its two children, said as: rows, the label, then x,y,w,h for the row and for each child
task say-row
  take label, like text
  take row, like view
  save whole
    call frame-of
      read row
  save first
    call frame-of
      call child-at
        read row
        code 0
  save second
    call frame-of
      call child-at
        read row
        code 1
  call say
    text <rows {{label}} {{whole}} {{first}} {{second}}>

task press-times
  take button, like view
  take times, like number
  walk size
    bind base, code 0
    bind head, read times
    hook next
      take site, name step
      call press
        read button

# the panel style-run made, kept so the run after the dialog can read it once the device is dark (native-dom-0048)
host styled-panels
  make list
  like list
    like view

# native-dom-0008: face's theme as a style table, applied by class and by state, read back off the platform's views.
# The panel is mounted last on the root, so the screenshot shows it and no earlier child moves
task style-run
  take root, like view
  save panel
    call create-element
      bind tag, text <div>
  call add-class
    read panel
    text <panel>
  save words
    call create-text
      text <Styled by face>
  call append
    read panel
    read words
  call append
    read root
    read panel
  call push
    bind list, read styled-panels
    bind item, read panel
  save panel-fill
    call style-of
      read panel
      text <background>
  save edge
    call style-of
      read panel
      text <border>
  save corner
    call style-of
      read panel
      text <border-radius>
  save ink
    call style-of
      read words
      text <color>
  save overlay
    call create-element
      bind tag, text <div>
  call add-class
    read overlay
    text <overlay>
  save hidden
    call style-of
      read overlay
      text <opacity>
  call set-attribute
    read overlay
    text <data-state>
    text <open>
  save shown
    call style-of
      read overlay
      text <opacity>
  save tag
    call create-element
      bind tag, text <span>
  call add-class
    read tag
    text <label>
  save tag-words
    call create-text
      text <Name>
  call append
    read tag
    read tag-words
  save size
    call style-of
      read tag-words
      text <font-size>
  save weight
    call style-of
      read tag-words
      text <font-weight>
  save pinned
    call create-element
      bind tag, text <div>
  call set-style
    read pinned
    text <background>
    text <#102030>
  call add-class
    read pinned
    text <panel>
  save kept
    call style-of
      read pinned
      text <background>
  save kept-edge
    call style-of
      read pinned
      text <border>
  save chip
    call create-element
      bind tag, text <div>
  call add-class
    read chip
    text <kbd>
  save chip-fill
    call style-of
      read chip
      text <background>
  call remove-class
    read chip
    text <kbd>
  save cleared
    call style-of
      read chip
      text <background>
  call say
    text <styles {{panel-fill}} {{edge}} {{corner}} {{ink}} {{hidden}} {{shown}} {{size}} {{weight}} {{kept}} {{kept-edge}} {{chip-fill}} {{cleared}}>

# the run after the dialog, called once the platform has dismissed it
task finish-run
  save missing, call unsupported-styles
  call say
    text <unsupported [{{missing}}]>
  call snapshot
    text <${shot}>
  call change-trait
    text <color-scheme>
    text <light>
  save box
    call create-element
      bind tag, text <div>
  call theme
    read box
  save before
    call serialize
      read box
  call say
    text <theme {{before}}>
  call say
    call traits-line
  call change-trait
    text <color-scheme>
    text <dark>
  save after
    call serialize
      read box
  call say
    text <theme {{after}}>
  save lit
    read styled-panels/0
  save dark-fill
    call style-of
      read lit
      text <background>
  save dark-ink
    call style-of
      call child-at
        read lit
        code 0
      text <color>
  call say
    text <styles dark {{dark-fill}} {{dark-ink}}>
  # native-dom-0035: the platform turns the device, and the app hears it the way it hears a person turning it
  save turn-box
    call create-element
      bind tag, text <div>
  call turn-watch
    read turn-box
  save width-before
    call trait-text
      text <width-class>
  save width-runs-before, read counted/width
  save scheme-runs-before, read counted/scheme
  call say
    text <turn before {{width-before}} {{width-runs-before}} {{scheme-runs-before}}>
  call make-effect
    task report
      save seen
        call trait-text
          text <width-class>
      fork test
        hook test
          call is-equal
            read seen
            read width-before
        hook miss
          save width-runs, read counted/width
          save scheme-runs, read counted/scheme
          call say
            text <turned {{seen}} {{width-runs}} {{scheme-runs}}>
          call exit-app
            code 0
        hook hold
          save skip, code 0
  call turn-device

task main
  # the style table goes to the host before anything is made, as an app's boot would hand it
  call use-styles
    text <${STYLE_TABLE}>
    text <${STYLE_TABLE_DARK}>
  save root
    call open-root
      text <Term, natively>
      code 420
      code 200
  call tally
    read root
  save wifi
    call make-disclosure
      bind start, false
  call switch
    read root
    text <>
    read wifi
  call sample-row
    read root
  call after-launch
    task check
      call show-window
      save button
        call child-at
          read root
          code 0
      call press-times
        read button
        code 5
      call say
        call serialize
          read root
      call press
        call child-at
          read root
          code 2
      call press-times
        read button
        code 6
      call say
        call serialize
          read root
      save row
        call child-at
          read root
          code 3
      save row-frame
        call frame-of
          read row
      call say
        text <frame row {{row-frame}}>
      save first-frame
        call frame-of
          call child-at
            read row
            code 0
      call say
        text <frame first {{first-frame}}>
      save second-frame
        call frame-of
          call child-at
            read row
            code 1
      call say
        text <frame second {{second-frame}}>
      # the layout rows, appended after both trees were read so WANT is unchanged; children 4 onward of the root
${LAYOUT_CALLS}      # native-dom-0026: the slider, two ways. Mounted off the window so the root's children stay as the rows expect
      save volume
        call make-range
          bind start, code 40.0
      save slider-box
        call create-element
          bind tag, text <div>
      call slider
        read slider-box
        text <>
        read volume
        code 0.0
        code 100.0
        code 0.5
      save slider-shown
        call serialize
          read slider-box
      call say
        text <slider shown {{slider-shown}}>
      call slide
        call child-at
          read slider-box
          code 0
        text <37.5>
      save heard
        call range-value
          read volume
      call say
        text <slider heard {{heard}}>
      call write-signal
        bind self, read volume
        bind value, code 20.0
      save slider-moved
        call serialize
          read slider-box
      call say
        text <slider moved {{slider-moved}}>
      # native-dom-0026: the select, two ways, off the window as the slider is
      save size
        call make-signal
          bind value, text <medium>
      save sizes, call size-names
      save select-box
        call create-element
          bind tag, text <div>
      call select
        read select-box
        text <>
        read size
        read sizes
      save select-shown
        call serialize
          read select-box
      call say
        text <select shown {{select-shown}}>
      call choose
        call child-at
          read select-box
          code 0
        text <large>
      save chosen
        call read-signal
          bind self, read size
      call say
        text <select heard {{chosen}}>
      call write-signal
        bind self, read size
        bind value, text <small>
      save select-moved
        call serialize
          read select-box
      call say
        text <select moved {{select-moved}}>
      # native-dom-0026: the input, two ways, off the window as the others are
      save greeting
        call make-signal
          bind value, text <hello>
      save input-box
        call create-element
          bind tag, text <div>
      call input
        read input-box
        text <>
        read greeting
        text <Your name>
      save input-shown
        call serialize
          read input-box
      call say
        text <input shown {{input-shown}}>
      call type-text
        call child-at
          read input-box
          code 0
        text <hello world>
      save typed
        call read-signal
          bind self, read greeting
      call say
        text <input heard {{typed}}>
      call write-signal
        bind self, read greeting
        bind value, text <bye>
      save input-moved
        call serialize
          read input-box
      call say
        text <input moved {{input-moved}}>
      call style-run
        read root
      # native-dom-0026: the dialog, presented by the platform and dismissed by the person
      save asking
        call make-disclosure
          bind start, false
      save dialog-box
        call create-element
          bind tag, text <div>
      call dialog
        read dialog-box
        text <>
        read asking
        text <Delete it?>
        read dialog-body
      save sheet
        call child-at
          read dialog-box
          code 0
      save closed-tree
        call serialize
          read sheet
      save page-tree
        call serialize
          read dialog-box
      call say
        text <dialog closed {{closed-tree}} page {{page-tree}}>
      call open-disclosure
        bind self, read asking
      # the platform presents it on its own turn, so it is read after one
      call later
        task opened
          save open-tree
            call serialize
              read sheet
          call say
            text <dialog opened {{open-tree}}>
          call dismiss
            read sheet
          call later
            task dismissed
              save after-dismiss
                call serialize
                  read sheet
              save still-open
                call disclosure-open
                  bind self, read asking
              call say
                text <dialog dismissed {{after-dismiss}} {{still-open}}>
              call finish-run
  call run-app
`

const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

// compile the program for one Apple platform, with the prelude its natives dock, into one Swift file
function swiftFor(env: 'macos' | 'ios', shot: string): string | undefined {
  const text = program(shot)
  const entry = join(dir, `${env}.tree`)
  writeFileSync(entry, text)
  const result = compile({ file: entry, text }, { resolve: projectResolver(ROOT, env), env })
  ok(`${env}: the program compiles`, result.ok, result.ok ? '' : result.diagnostics.slice(0, 4).map(d => d.message).join(' | '))

  if (!result.ok) {
    return undefined
  }

  const swift = emitSwift(result.program)
  const prelude = nativePrelude(result.program, env, readRuntime, swift)
  ok(`${env}: the Apple view runtime is in the prelude`, prelude.includes('enum nativeView'))
  const file = join(dir, `${env}.swift`)
  writeFileSync(file, ['import Foundation', prelude, swift, 'main()', ''].join('\n'))

  return file
}

function builds(label: string, command: string, args: string[]): boolean {
  try {
    execFileSync(command, args, { stdio: 'pipe' })
    ok(`${label}: builds`, true)

    return true
  } catch (e) {
    const text = String((e as { stderr?: Buffer }).stderr ?? e)
    ok(`${label}: builds`, false, text.split('\n').filter(l => /error:/.test(l)).join('\n').slice(0, 1600) || text.slice(0, 800))

    return false
  }
}

// what both platforms must print: the tree read back from their own views
function judge(env: string, toolkit: string, output: string, shot: string): void {
  const lines = output.split('\n').map(l => l.trim()).filter(l => l.startsWith('<main>'))
  ok(`${env}: five presses read back from ${toolkit}: ${WANT[0]}`, lines[0] === WANT[0], JSON.stringify(lines[0]))
  ok(`${env}: eleven presses read back from ${toolkit}: ${WANT[1]}`, lines[1] === WANT[1], JSON.stringify(lines[1]))
  // the row: the platform's stack put the second button exactly 12 after the first, the first 8 inside the row, and
  // centred them on one line. Read back from the views, so a mapping that did nothing cannot pass
  const frame = (name: string): number[] | undefined => {
    const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`frame ${name} `))

    return line?.slice(line.indexOf(`frame ${name} `) + `frame ${name} `.length).split(',').map(Number)
  }
  const [row, first, second] = [frame('row'), frame('first'), frame('second')]
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  ok(`${env}: the gap is the platform stack's spacing, 12`, !!first && !!second && near(second[0], first[0] + first[2] + 12), JSON.stringify({ first, second }))
  ok(`${env}: the padding is the stack's inset, 8`, !!row && !!first && near(first[0] - row[0], 8) && first[1] - row[1] >= 7, JSON.stringify({ row, first }))
  ok(`${env}: align-items center puts both on one line`, !!first && !!second && near(first[1] + first[3] / 2, second[1] + second[3] / 2), JSON.stringify({ first, second }))
  // native-dom-0026: the slider is the platform's control, and the value goes both ways through it
  const sliderLine = (what: string) => {
    const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`slider ${what} `))

    return line?.slice(line.indexOf(`slider ${what} `) + `slider ${what} `.length)
  }
  ok(`${env}: the slider shows the range's 40, read back from the platform's control`, sliderLine('shown') === '<div><slider value="40"></slider></div>', String(sliderLine('shown')))
  ok(`${env}: a move to 37.5 made on the control, half a step, is written into the range`, Number(sliderLine('heard')) === 37.5, String(sliderLine('heard')))
  ok(`${env}: the range written to 20 moves the control`, sliderLine('moved') === '<div><slider value="20"></slider></div>', String(sliderLine('moved')))
  const selectLine = (what: string) => {
    const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`select ${what} `))

    return line?.slice(line.indexOf(`select ${what} `) + `select ${what} `.length)
  }
  ok(`${env}: the select shows the signal's medium, read back from the platform's picker`, selectLine('shown') === '<div><select value="medium"></select></div>', String(selectLine('shown')))
  ok(`${env}: large chosen on the picker is written into the signal`, selectLine('heard') === 'large', String(selectLine('heard')))
  ok(`${env}: the signal written to small moves the picker`, selectLine('moved') === '<div><select value="small"></select></div>', String(selectLine('moved')))
  const inputLine = (what: string) => {
    const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`input ${what} `))

    return line?.slice(line.indexOf(`input ${what} `) + `input ${what} `.length)
  }
  ok(`${env}: the input shows the signal's hello, read back from the platform's field`, inputLine('shown') === '<div><input value="hello"></input></div>', String(inputLine('shown')))
  ok(`${env}: hello world typed into the field is written into the signal`, inputLine('heard') === 'hello world', String(inputLine('heard')))
  ok(`${env}: the signal written to bye shows in the field`, inputLine('moved') === '<div><input value="bye"></input></div>', String(inputLine('moved')))
  const dialogLine = (what: string) => {
    const line = output.split('\n').map(l => l.trim()).find(l => l.includes(`dialog ${what} `))

    return line?.slice(line.indexOf(`dialog ${what} `) + `dialog ${what} `.length)
  }
  ok(
    `${env}: the dialog holds its content, closed, and is not in the page it was given`,
    dialogLine('closed') === '<sheet open="false"><span>Sure?</span></sheet> page <div></div>',
    String(dialogLine('closed')),
  )
  ok(`${env}: opening the disclosure has the platform present it`, dialogLine('opened') === '<sheet open="true"><span>Sure?</span></sheet>', String(dialogLine('opened')))
  ok(
    `${env}: the person's dismissal ends the presentation and closes the disclosure`,
    dialogLine('dismissed') === '<sheet open="false"><span>Sure?</span></sheet> false',
    String(dialogLine('dismissed')),
  )
  // native-dom-0027: the words 0007 did not run, judged by the one judge the web is held to as well
  for (const [name, passed, info] of judgeLayout(output)) {
    ok(`${env}: ${name}`, passed, info)
  }
  // native-dom-0008: face's theme drawn by the platform, read back off the views
  const styles = output.split('\n').map(l => l.trim()).find(l => l.includes('styles #'))
  ok(`${env}: face's style table drawn by ${toolkit}: ${WANT_STYLES}`, !!styles && styles.endsWith(WANT_STYLES), String(styles))
  const dark = output.split('\n').map(l => l.trim()).find(l => l.includes('styles dark '))
  ok(`${env}: the device turned dark restyles the panel from the dark table: ${WANT_DARK_STYLES}`, !!dark && dark.endsWith(WANT_DARK_STYLES), String(dark))
  const missing = output.split('\n').map(l => l.trim()).find(l => l.includes('unsupported ['))
  ok(`${env}: every style mapped onto the platform`, missing !== undefined && missing.endsWith('unsupported []'), String(missing))
  ok(`${env}: a PNG of the screen was written`, existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot)
  // the device traits (native-dom-0012), read from the platform: the span bound to the color scheme reads `light` once
  // the platform is forced light, and `dark` after the platform is forced dark and reports it through its own watcher
  const said = output.split('\n').map(l => l.trim())
  const themes = said.filter(l => l.includes('theme <')).map(l => l.slice(l.indexOf('theme <') + 'theme '.length))
  ok(`${env}: the color scheme reads light from the platform`, themes[0] === '<div><span>light</span></div>', JSON.stringify(themes[0]))
  ok(`${env}: the platform's change to dark rewrites the span`, themes[1] === '<div><span>dark</span></div>', JSON.stringify(themes[1]))
  const traits = said.find(l => l.includes('traits '))
  const read = traits?.slice(traits.indexOf('traits ') + 'traits '.length).split(' ') ?? []
  const [idiom, width, pointer, motion, scale] = read
  const expected = env === 'macos' ? ['desktop', 'fine'] : ['phone', 'touch']
  ok(`${env}: idiom and pointer are the platform's, ${expected.join(' and ')}`, idiom === expected[0] && pointer === expected[1], String(traits))
  // read from the window: compact or regular. Which one depends on how the device was left, which the turn below
  // relies on and checks both ways over time
  ok(`${env}: the width class is read`, width === 'compact' || width === 'regular', String(traits))
  ok(`${env}: reduce motion and text scale are read`, (motion === 'yes' || motion === 'no') && Number(scale) > 0, String(traits))
  // native-dom-0035: a real turn, reported by the platform. Compact before, regular after, and of the two spans only
  // the one reading the width computed its text again: once before, once after; the scheme span once in all
  const before = said.find(l => l.includes('turn before '))
  const turned = said.find(l => l.includes('turned '))
  const [widthBefore, widthRunsBefore, schemeRunsBefore] = before?.slice(before.indexOf('turn before ') + 'turn before '.length).split(' ') ?? []
  const [widthAfter, widthRuns, schemeRuns] = turned?.slice(turned.indexOf('turned ') + 'turned '.length).split(' ') ?? []
  // the turn goes to whichever shape the device was not in, so the class flips: compact to regular from portrait or a
  // narrow window, regular to compact from landscape
  const flipped = { compact: 'regular', regular: 'compact' } as Record<string, string>
  ok(`${env}: before the turn each span computed once`, !!flipped[widthBefore ?? ''] && widthRunsBefore === '1' && schemeRunsBefore === '1', String(before))
  ok(`${env}: the platform's turn flips the width class, ${widthBefore} to ${flipped[widthBefore ?? '']}`, !!widthAfter && widthAfter === flipped[widthBefore ?? ''], String(turned))
  ok(`${env}: only the span reading the width ran again`, widthRuns === '2' && schemeRuns === '1', String(turned))
}

function runMacos(): void {
  const file = swiftFor('macos', png)
  const exe = join(dir, 'macos')

  if (file && builds('macos', 'swiftc', ['-o', exe, file])) {
    const run = spawnSync(exe, [], { encoding: 'utf8', timeout: 60_000 })
    ok('macos: the app exits 0', run.status === 0, `exit ${run.status} ${run.signal ?? ''}: ${(run.stdout + run.stderr).slice(0, 400)}`)
    judge('macos', 'AppKit', run.stdout, png)
  }
}

// the simulator SDK, a flat .app, installed clean on a booted iPhone simulator, its console read until it exits
function runIos(): void {
  const found = simulator()

  if ('missing' in found) {
    console.log(`skip  ios  (${found.missing})`)

    return
  }

  const shot = process.env.SNAPSHOT_IOS ?? join(dir, 'ios.png')
  const file = swiftFor('ios', shot)
  const identifier = 'surf.term.native-dom-test'
  const bundle = assembleIosBundle({ out: join(dir, 'ios'), name: 'NativeDom', identifier, version: '0.0.2' })
  const sdk = execFileSync('xcrun', ['-sdk', 'iphonesimulator', '--show-sdk-path'], { encoding: 'utf8' }).trim()

  if (!file || !builds('ios', 'xcrun', ['-sdk', 'iphonesimulator', 'swiftc', '-target', 'arm64-apple-ios17.0-simulator', '-sdk', sdk, '-o', bundle.exe, file])) {
    return
  }

  spawnSync('xcrun', ['simctl', 'terminate', found.udid, identifier], { stdio: 'ignore' })
  spawnSync('xcrun', ['simctl', 'uninstall', found.udid, identifier], { stdio: 'ignore' })
  execFileSync('xcrun', ['simctl', 'install', found.udid, bundle.app], { stdio: 'pipe' })
  const run = spawnSync('xcrun', ['simctl', 'launch', '--console', '--terminate-running-process', found.udid, identifier], {
    encoding: 'utf8',
    timeout: 120_000,
  })
  const output = `${run.stdout ?? ''}${run.stderr ?? ''}`
  ok('ios: the app said it exits 0', output.includes('native-view exit 0'), output.slice(0, 600))
  judge('ios', 'UIKit', output, shot)
}

// kotlinc and d8, an APK with no assets, installed on the emulator, the `native-dom` log read until the app says it
// exits, and the PNG pulled out of the app's own files directory (a debug APK lets `run-as` read it)
function runAndroid(): void {
  const found = androidDevice()

  if ('missing' in found) {
    console.log(`skip  android  (${found.missing})`)

    return
  }

  const tools = androidTools()
  const adb = (...args: string[]) => spawnSync(tools.adb, ['-s', found.serial, ...args], { encoding: 'utf8' })
  const identifier = 'surf.term.nativedom'
  const work = join(dir, 'android')
  const assets = join(work, 'assets')
  mkdirSync(assets, { recursive: true })
  const entry = join(dir, 'android.tree')
  writeFileSync(entry, program('native-dom.png'))

  let apk: string

  try {
    const { dex } = buildAndroidProgram({
      root: ROOT,
      entry,
      identifier,
      // the Activity Android starts runs the program inside onCreate, once a view can be made
      driver: ['class TermActivity : TermViewActivity() {', '  override fun program() { main() }', '}'].join('\n'),
      work,
      env: 'android',
    })
    apk = assembleApk({ out: work, name: 'NativeDom', identifier, version: '0.0.2', dex, assets, work })
    ok('android: builds', true)
  } catch (e) {
    ok('android: builds', false, String((e as { stderr?: Buffer }).stderr ?? e).split('\n').filter(l => /error|e: /.test(l)).join('\n').slice(0, 1600))

    return
  }

  adb('uninstall', identifier)
  adb('logcat', '-c')
  const installed = adb('install', '-r', apk)
  ok('android: installs', installed.status === 0, `${installed.stdout}${installed.stderr}`.slice(0, 400))
  adb('shell', 'am', 'start', '-n', `${identifier}/.TermActivity`)

  // the app logs every line under `native-dom` and says when it exits
  let log = ''
  const deadline = Date.now() + 120_000

  while (Date.now() < deadline) {
    log = adb('logcat', '-d', '-s', 'native-dom:I').stdout ?? ''

    if (log.includes('native-view exit')) {
      break
    }

    spawnSync('sleep', ['1'])
  }

  const said = log
    .split('\n')
    .map(line => line.slice(line.indexOf('native-dom:') + 'native-dom:'.length).trim())
    .join('\n')
  ok('android: the app said it exits 0', said.includes('native-view exit 0'), log.slice(-600))

  const shot = process.env.SNAPSHOT_ANDROID ?? join(dir, 'android.png')
  // the app's external files directory, which adb reads without a debuggable build
  const pulled = spawnSync(tools.adb, ['-s', found.serial, 'exec-out', 'cat', `/sdcard/Android/data/${identifier}/files/native-dom.png`])

  if (pulled.status === 0 && pulled.stdout.length > 0) {
    writeFileSync(shot, pulled.stdout)
  }

  judge('android', 'Android views', said, shot)
}

const only = process.env.TOOLKIT_ONLY ?? ''
const apple = process.platform === 'darwin'

if (!only || only === 'macos') {
  apple ? runMacos() : console.log('skip  macos  (AppKit is macOS only)')
}

if (!only || only === 'ios') {
  apple ? runIos() : console.log('skip  ios  (the iOS simulator is macOS only)')
}

if (!only || only === 'android') {
  runAndroid()
}

console.log(`\ntoolkit-view: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
