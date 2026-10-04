// The portable keyboard on the toolkit hosts (swiftui-target-0003, `listen-key`): AppKit's key-down monitor (macOS), the
// root controller's presses (the iPhone simulator) and the Activity's key dispatch (the Android emulator). The program
// listens for keys and draws the ones it hears in a span, presses Escape, `a` and the up arrow through the platform
// (`type-key`: a key event posted to the app on macOS, a KeyEvent dispatched through the Activity on Android, the root
// controller's delivery on iOS, where a test cannot make a UIPress), and reads the span back off the platform's view.
// On Compose (compose-target-0003) the window's root box hears the keys through onPreviewKeyEvent, and `type-key` focuses
// it and injects real key events through Compose's own test input.
// KEYS_ONLY=macos (or ios, android, compose) runs one platform. Run: npx tsx test/compile/toolkit-keys.ts

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runToolkits } from './shared/toolkit-run'
import type { Leg } from './shared/toolkit-run'

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

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find serialize
  find snapshot
  find say
  find later
  find listen-key
  find type-key

load @term/base/text/string
  find concat

task heard-text
  take heard, like signal text
  like text
  send back
    call read-signal
      bind self, read heard

view board
  take host, like view
  take heard, like signal text
  view span
    read
      call heard-text
        read heard

task main
  save heard
    call make-signal
      bind value, text <keys:>
  save root
    call open-root
      text <Term keys>
      code 320
      code 200
  call board
    read root
    read heard
  save drop
    call listen-key
      task hear
        take key, like text
        call write-signal
          bind self, read heard
          bind value
            call concat
              call concat
                call read-signal
                  bind self, read heard
                text < >
              read key
  call after-launch
    task check
      call show-window
      call type-key
        text <Escape>
      call type-key
        text <a>
      call type-key
        text <ArrowUp>
      call later
        task after
          save drawn
            call serialize
              read root
          call say
            text <step keys {{drawn}}>
          call snapshot
            text <${shot}>
          call exit-app
            code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const drawn = step(output, 'keys')
  ok(`${leg}: three keys pressed through the platform reach the listener under their web names (${toolkit})`, drawn.includes('keys: Escape a ArrowUp'), drawn)
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-keys-')),
    name: 'Keys',
    iosIdentifier: 'surf.term.toolkit-keys-test',
    androidIdentifier: 'surf.term.toolkitkeys',
    program,
    judge,
    ok,
    shots: {},
    compose: true,
  },
  process.env.KEYS_ONLY ?? '',
)

console.log(`\ntoolkit-keys: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
