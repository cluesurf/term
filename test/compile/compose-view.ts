// A Term view drawn by Compose (compose-target-0001): the program the toolkit hosts run (test/compile/toolkit-view.ts),
// through the SAME toolkit dom (deck/site/code/dom/native/toolkit/dom.tree), with the Compose runtime
// (deck/site/code/dom/native/compose/runtime/native-view.kt) in the place of the Android one. Compiled by kotlinc with the
// Compose compiler plugin, run on the desktop JVM through Compose Multiplatform with no window (TERM_WINDOW_AWAY=1: the
// runtime hosts the tree in Compose's desktop test host), and every answer is READ BACK FROM COMPOSE'S SEMANTICS: a
// button's text, a switch's state, a slider's progress, a field's text, where a control was laid out.
//
// The same program, the same judgments as the Android leg where the platforms agree. Each control box is mounted in the
// window, where the Android leg leaves the slider, select and input off it: Compose draws, and has semantics for, only
// what is composed, so a control off the window has nothing to read back.
//
// Needs kotlinc and java, and the Compose libraries `task/term/native/kotlin.sh compose-deps` resolves (fetching
// Gradle into the cache if none is installed). Skipped, never failed, without kotlinc or java.
// Run: npx tsx test/compile/compose-view.ts

import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildCompose, buildComposeAndroid } from '@term/call/code/compose'
import { runCompose } from './shared/compose-build'
import { runComposeAndroid } from './shared/compose-android'
import { LAYOUT_LABELS, LAYOUT_ROWS, judgeLayout } from './shared/layout-rows'

// the style table (native-dom-0008's format, `<class>|<state>|<property>: <value>` rows joined by `;`), light and dark
const STYLE_LIGHT = [
  'panel||background: #f4f4f5',
  'panel||border: 1px solid #d4d4d8',
  'panel||border-radius: 8px',
  'panel||color: #18181b',
  'panel||padding: 12px',
  'overlay||opacity: 0',
  'overlay|data-state=open|opacity: 1',
  'label||font-size: 14px',
  'label||font-weight: 600',
  'kbd||background: #e4e4e7',
].join(';')
const STYLE_DARK = STYLE_LIGHT.replace('#f4f4f5', '#09090b').replace('#18181b', '#f4f4f5').replace('#d4d4d8', '#27272a')

// what the style run must read back, worked out from the table: the panel's fill (off the pixels), edge, corners and
// the color its words inherit; the overlay hidden, then shown by its state; the label's size and weight; the inline
// fill winning over the class's while the class's edge stays; the chip's fill, then none once its class is gone
const WANT_STYLES = 'styles #f4f4f5 1px #d4d4d8 8px #18181b 0 1 14px 600 #102030 1px #d4d4d8 #e4e4e7 none'
const WANT_DARK = 'styles dark #09090b #f4f4f5'

// every layout row mounted on the root, then each one's frames said, for the one judge the web and every toolkit answer
// to (./shared/layout-rows.ts)
const LAYOUT_CALLS =
  LAYOUT_LABELS.map(([, view]) => `      save ${view}-box, call box-in(read root)\n      call ${view}\n        read ${view}-box\n`).join('') +
  LAYOUT_LABELS.map(
    ([label, view]) => `      call say-row\n        text <${label}>\n        call child-at\n          read ${view}-box\n          code 0\n`,
  ).join('')

let pass = 0
let fail = 0

function check(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const ROOT = join(import.meta.dirname, '../..')
const dir = mkdtempSync(join(tmpdir(), 'term-compose-view-'))
const desktopShot = process.env.SNAPSHOT_COMPOSE ?? join(dir, 'compose.png')
const androidShot = process.env.SNAPSHOT_COMPOSE_ANDROID ?? join(dir, 'compose-android.png')
const ANDROID_IDENTIFIER = 'surf.term.composeview'

// what the tree must read back as, worked out by hand: the tally pressed 5 times, then the switch pressed and the
// tally 6 more
const WANT = [
  '<div><button>5</button><span>low</span><switch checked="false"></switch><div><button>a</button><button>bb</button></div></div>',
  '<div><button>11</button><span>high</span><switch checked="true"></switch><div><button>a</button><button>bb</button></div></div>',
]

// the program, writing its PNG at `shot` (a path on the desktop, a file name in the app's files directory on Android)
const program = (shot: string): string => `load @term/site/code/view/reactive
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
  find create-text

load @term/face/code/component/switch
  find switch

load @term/face/code/logic/disclosure
  find make-disclosure

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
  find disclosure-open
  find open-disclosure

load @term/site/code/view/render
  find render-each
  find last-raise

load @term/base/code/list
  find list
  find push

load @term/site/code/dom/native/toolkit/dom
  find create-element
  find frame-of
  find open-root
  find after-launch
  find run-app
  find exit-app
  find press
  find slide
  find choose
  find type-text
  find child-at
  find serialize
  find snapshot
  find say
  find get-value
  find set-value
  find later
  find dismiss
  find style-of
  find add-class
  find remove-class
  find set-attribute
  find set-style

load @term/site/code/dom/style
  find use-styles

load @term/site/code/view/native/toolkit/device
  find change-trait

# the style table (compose-target): classes, a state attribute, an inline fill and the dark scheme, each read back
# with style-of. Mounted on the root, since a fill is read off the pixels Compose drew
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
      text <Styled by the table>
  call append
    read panel
    read words
  call append
    read root
    read panel
  save fill
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
  call append
    read root
    read overlay
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
  call append
    read root
    read tag
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
  call append
    read root
    read pinned
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
  call set-style
    read chip
    text <padding>
    text <8px>
  call add-class
    read chip
    text <kbd>
  call append
    read root
    read chip
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
    text <styles {fill} {edge} {corner} {ink} {hidden} {shown} {size} {weight} {kept} {kept-edge} {chip-fill} {cleared}>
  call change-trait
    text <color-scheme>
    text <dark>
  save dark-fill
    call style-of
      read panel
      text <background>
  save dark-ink
    call style-of
      read words
      text <color>
  call say
    text <styles dark {dark-fill} {dark-ink}>

view dialog-body
  take host, like view
  view span
    text <Sure?>

# the exception carrier (compose-target-0003): a click handler that raises, one that counts, the count, and the last
# raise's note, read reactively from the render runtime's \`last-raise\`
task refuse
  halt <no more>

task count-text
  take count, like signal
  like text
  send back
    call read-signal
      bind self, read count

view refusal
  take host, like view
  save count
    call make-signal
      bind value, text <0>
  view button
    hook click
      call refuse
    text <refuse>
  view button
    hook click
      call write-signal
        bind self, read count
        bind value, text <1>
    text <count>
  view span
    read
      call count-text
        read count
  view span
    read
      call last-raise

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

# the list word: a field, a button that adds what it holds, the notes as a \`walk\`, and a sibling after the list, which
# the list's items must stay before as it grows
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
  view span
    text <end>

task shown
  take count, like signal number
  like text
  save value
    call read-signal
      bind self, read count
  send back, text <{value}>

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

view sample-row
  take host, like view
  view div
    bind style, text <display: flex; flex-direction: row; gap: 12px; align-items: center; padding: 8px>
    view button
      text <a>
    view button
      text <bb>

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

${LAYOUT_ROWS}

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
    text <rows {label} {whole} {first} {second}>

task box-in
  take root, like view
  like view
  save box
    call create-element
      bind tag, text <div>
  call append
    read root
    read box
  send back, read box

task main
  # the style table goes to the host before anything is made, as an app's boot would hand it
  call use-styles
    text <${STYLE_LIGHT}>
    text <${STYLE_DARK}>
  save root
    call open-root
      text <Term on Compose>
      code 640
      code 2400
  save top, call box-in(read root)
  call tally
    read top
  save wifi
    call make-disclosure
      bind start, false
  call switch
    read top
    text <>
    read wifi
  call sample-row
    read top
  save volume
    call make-range
      bind start, code 40.0
  save slider-box, call box-in(read root)
  call slider
    read slider-box
    text <>
    read volume
    code 0.0
    code 100.0
    code 0.5
  save size
    call make-signal
      bind value, text <medium>
  save sizes, call size-names
  save select-box, call box-in(read root)
  call select
    read select-box
    text <>
    read size
    read sizes
  save greeting
    call make-signal
      bind value, text <hello>
  save input-box, call box-in(read root)
  call input
    read input-box
    text <>
    read greeting
    text <Your name>
  save notes-box, call box-in(read root)
  call notes
    read notes-box
  save refusal-box, call box-in(read root)
  call refusal
    read refusal-box
  save asking
    call make-disclosure
      bind start, false
  save dialog-box, call box-in(read root)
  call dialog
    read dialog-box
    text <>
    read asking
    text <Delete it?>
    read dialog-body
  call after-launch
    task check
      save button
        call child-at
          read top
          code 0
      call press-times
        read button
        code 5
      call say
        call serialize
          read top
      call press
        call child-at
          read top
          code 2
      call press-times
        read button
        code 6
      call say
        call serialize
          read top
      save row
        call child-at
          read top
          code 3
      save row-frame
        call frame-of
          read row
      call say
        text <frame row {row-frame}>
      save first-frame
        call frame-of
          call child-at
            read row
            code 0
      call say
        text <frame first {first-frame}>
      save second-frame
        call frame-of
          call child-at
            read row
            code 1
      call say
        text <frame second {second-frame}>
      save slider-shown
        call serialize
          read slider-box
      call say
        text <slider shown {slider-shown}>
      call slide
        call child-at
          read slider-box
          code 0
        text <37.5>
      save heard
        call range-value
          read volume
      call say
        text <slider heard {heard}>
      call write-signal
        bind self, read volume
        bind value, code 20.0
      save slider-moved
        call serialize
          read slider-box
      call say
        text <slider moved {slider-moved}>
      save select-shown
        call serialize
          read select-box
      call say
        text <select shown {select-shown}>
      call choose
        call child-at
          read select-box
          code 0
        text <large>
      save chosen
        call read-signal
          bind self, read size
      call say
        text <select heard {chosen}>
      call write-signal
        bind self, read size
        bind value, text <small>
      save select-moved
        call serialize
          read select-box
      call say
        text <select moved {select-moved}>
      save input-shown
        call serialize
          read input-box
      call say
        text <input shown {input-shown}>
      call type-text
        call child-at
          read input-box
          code 0
        text <hello world>
      save typed
        call read-signal
          bind self, read greeting
      call say
        text <input heard {typed}>
      call write-signal
        bind self, read greeting
        bind value, text <bye>
      save input-moved
        call serialize
          read input-box
      call say
        text <input moved {input-moved}>
${LAYOUT_CALLS}      save note-row
        call child-at
          read notes-box
          code 0
      call type-text
        call child-at
          read note-row
          code 0
        text <hi>
      call press
        call child-at
          read note-row
          code 1
      call type-text
        call child-at
          read note-row
          code 0
        text <yo>
      call press
        call child-at
          read note-row
          code 1
      save notes-tree
        call serialize
          read notes-box
      call say
        text <notes {notes-tree}>
      call press
        call child-at
          read refusal-box
          code 0
      save refused
        call serialize
          read refusal-box
      call say
        text <raise refused {refused}>
      call press
        call child-at
          read refusal-box
          code 1
      save counted
        call serialize
          read refusal-box
      call say
        text <raise counted {counted}>
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
        text <dialog closed {closed-tree} page {page-tree}>
      call open-disclosure
        bind self, read asking
      call later
        task opened
          save open-tree
            call serialize
              read sheet
          call say
            text <dialog opened {open-tree}>
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
                text <dialog dismissed {after-dismiss} {still-open}>
              # light first, so a machine already in dark mode cannot decide the first reading
              call change-trait
                text <color-scheme>
                text <light>
              call style-run
                read root
              call snapshot
                text <${shot}>
              call exit-app
                code 0
  call run-app
`

// the desktop: Compose Multiplatform on the JVM, headless (./shared/compose-build.ts, which also checks no Android class
// reached the prelude)
function desktop(): void {
  const built = buildCompose({ root: ROOT, dir, name: 'compose', text: program(desktopShot) })

  if (built.form === 'skipped') {
    console.log(`skip  desktop: ${built.reason}`)

    return
  }

  check('desktop: the program compiles for the toolkit dom and kotlinc builds it with the Compose plugin', built.form === 'built', built.form === 'failed' ? `${built.stage}: ${built.reason}` : '')

  if (built.form !== 'built') {
    return
  }

  const ran = runCompose(built)
  check('desktop: the app said it exits 0', ran.output.includes('native-view exit 0') && ran.status === 0, `status ${ran.status}: ${ran.error.slice(-1200)}`)
  judge('desktop', ran.output, desktopShot)
}

// Android: Jetpack Compose, an APK made with no Android Gradle plugin (./shared/compose-android.ts), installed on the
// emulator, its lines read from logcat and its PNG pulled off the device
function android(): void {
  const built = buildComposeAndroid({ root: ROOT, dir, name: 'compose', text: program('compose.png'), identifier: ANDROID_IDENTIFIER })

  if (built.form === 'skipped') {
    console.log(`skip  android: ${built.reason}`)

    return
  }

  check('android: the APK builds from Compose\'s Android libraries, resources linked by aapt2 and dexed by d8', built.form === 'built', built.form === 'failed' ? `${built.stage}: ${built.reason}` : '')

  if (built.form !== 'built') {
    return
  }

  const ran = runComposeAndroid({ apk: built.apk, identifier: ANDROID_IDENTIFIER, shot: 'compose.png', pulled: androidShot })

  if (ran.form === 'skipped') {
    console.log(`skip  android: ${ran.reason}`)

    return
  }

  check('android: it installs on the emulator', ran.installed)
  check('android: the app said it exits 0', ran.exited, ran.output.slice(-1600))
  judge('android', ran.output, androidShot)
}

// every judgment, the same on both legs, each worked out by hand
function judge(leg: string, said: string, shot: string): void {
  const ok = (name: string, cond: boolean, info = ''): void => check(`${leg}: ${name}`, cond, info)
  const lines = said.split('\n').filter(one => one.trim() !== '' && !one.startsWith('---------'))
  const line = (prefix: string): string | undefined => lines.find(one => one.startsWith(prefix))?.slice(prefix.length)

  ok(`five presses read back from Compose: ${WANT[0]}`, lines[0] === WANT[0], JSON.stringify(lines[0]))
  ok(`the switch and six more read back from Compose: ${WANT[1]}`, lines[1] === WANT[1], JSON.stringify(lines[1]))

  const frame = (name: string) => line(`frame ${name} `)?.split(',').map(Number)
  const [row, first, second] = [frame('row'), frame('first'), frame('second')]
  const near = (a: number, b: number) => Math.abs(a - b) <= 1
  ok('the gap is the row arrangement\'s spacing, 12', !!first && !!second && near(second[0]!, first[0]! + first[2]! + 12), JSON.stringify({ first, second }))
  // across, exactly 8. Down, at least 8: a Material button draws 36dp tall inside the 48dp touch target Compose
  // reserves for every control (its accessibility minimum), so the drawn button sits 6dp below the inset, as the
  // Android leg allows for its own controls
  ok('the padding is the row\'s inset, 8', !!row && !!first && near(first[0]! - row[0]!, 8) && first[1]! - row[1]! >= 7, JSON.stringify({ row, first }))
  ok(
    'align-items center puts both buttons on one line',
    !!first && !!second && near(first[1]! + first[3]! / 2, second[1]! + second[3]! / 2),
    JSON.stringify({ first, second }),
  )

  ok('the slider shows the range\'s 40, read off its progress', line('slider shown ') === '<div><slider value="40"></slider></div>', String(line('slider shown ')))
  ok('a move to 37.5, half a step, made through the slider\'s own action, is written into the range', Number(line('slider heard ')) === 37.5, String(line('slider heard ')))
  ok('the range written to 20 moves the slider', line('slider moved ') === '<div><slider value="20"></slider></div>', String(line('slider moved ')))
  ok('the select shows the signal\'s medium', line('select shown ') === '<div><select value="medium"></select></div>', String(line('select shown ')))
  ok('large chosen is written into the signal', line('select heard ') === 'large', String(line('select heard ')))
  ok('the signal written to small moves the select', line('select moved ') === '<div><select value="small"></select></div>', String(line('select moved ')))
  ok('the input shows the signal\'s hello, read off the field\'s text', line('input shown ') === '<div><input value="hello"></input></div>', String(line('input shown ')))
  ok('hello world typed into the field is written into the signal', line('input heard ') === 'hello world', String(line('input heard ')))
  ok('the signal written to bye shows in the field', line('input moved ') === '<div><input value="bye"></input></div>', String(line('input moved ')))
  // the layout model (compose-target-0002), by the one judge the web and every toolkit are held to
  for (const [name, passed, info] of judgeLayout(said)) {
    ok(`layout: ${name}`, passed, info)
  }

  // the list: two notes added through the field and the button, in order, and the sibling after the list still last
  ok(
    'two notes typed and added are drawn as the list, in order, before the sibling after it',
    line('notes ') === '<div><div><input value=""></input><button>add</button></div><p>hi</p><p>yo</p><span>end</span></div>',
    String(line('notes ')),
  )
  // the exception carrier: the raise in a click handler ends nothing, its note reaches the span, and the next click
  // is still handled
  ok(
    'a raise in a click handler is caught, and its note reaches the UI',
    line('raise refused ') === '<div><button>refuse</button><button>count</button><span>0</span><span>no more</span></div>',
    String(line('raise refused ')),
  )
  ok(
    'after the raise the app keeps handling clicks',
    line('raise counted ') === '<div><button>refuse</button><button>count</button><span>1</span><span>no more</span></div>',
    String(line('raise counted ')),
  )
  // the dialog: what it holds while closed, out of the page; presented by Compose when the disclosure opens; ended by
  // the person's dismissal, which closes the disclosure
  ok(
    'the dialog holds its content, closed, and is not in the page it was given',
    line('dialog closed ') === '<sheet open="false"><span>Sure?</span></sheet> page <div></div>',
    String(line('dialog closed ')),
  )
  ok(
    'opening the disclosure has Compose compose the dialog',
    line('dialog opened ') === '<sheet open="true"><span>Sure?</span></sheet>',
    String(line('dialog opened ')),
  )
  ok(
    'the person\'s dismissal ends the dialog and closes the disclosure',
    line('dialog dismissed ') === '<sheet open="false"><span>Sure?</span></sheet> false',
    String(line('dialog dismissed ')),
  )
  // the style table: classes, a state, an inline fill, a class removed, then the dark scheme, the fill off the pixels
  const styles = lines.find(one => one.startsWith('styles #') || one.startsWith('styles none'))
  ok(`the style table drawn by Compose: ${WANT_STYLES}`, styles === WANT_STYLES, String(styles))
  ok(`the scheme turned dark restyles the panel from the dark table: ${WANT_DARK}`, line('styles dark ') === WANT_DARK.slice('styles dark '.length), String(line('styles dark ')))
  ok('a PNG of what Compose drew was written', existsSync(shot) && readFileSync(shot).subarray(1, 4).toString() === 'PNG', shot)
}

// COMPOSE_VIEW_ONLY=desktop (or android) runs one leg
const only = process.env.COMPOSE_VIEW_ONLY ?? ''

if (!only || only === 'desktop') {
  desktop()
}

if (!only || only === 'android') {
  android()
}

console.log(`\ncompose-view: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
