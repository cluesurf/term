// SwiftUI in a slot of the retained tree (swiftui-target-0001, native-view.swift `hostedViews`): a `swiftui` element
// naming a registered SwiftUI view, on AppKit (macOS) and UIKit (the iPhone simulator). The program hosts SwiftUI's
// Stepper and ProgressView beside a span showing a count it keeps in a signal, presses the stepper's increment twice
// the way a tap would, and reads back:
//
//   - both hosting views are installed in the tree and laid out by SwiftUI to a size above zero
//   - each press reached the program's `change` handler, which wrote the count, so the span reads 2
//   - the count went back into the SwiftUI view's input through its attribute (the slot holds `value` 2)
//
// SWIFTUI_ONLY=macos (or ios) runs one platform. Run: npx tsx test/compile/toolkit-swiftui.ts

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
  find get-value

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
  find child-at
  find serialize
  find snapshot
  find say
  find later
  find hosted-name
  find hosted-attribute
  find perform-hosted

task count-text
  take count, like signal
  like text
  send back
    call read-signal
      bind self, read count

view board
  take host, like view
  save count
    call make-signal
      bind value, text <0>
  view swiftui
    name stepper
    bind name, text <stepper>
    bind label, text <count>
    bind value
      call count-text
        read count
    seed change
      call write-signal
        bind self, read count
        bind value
          call get-value
            read stepper
  view swiftui
    bind name, text <progress>
    bind label, text <done>
    bind value, text <0.25>
  view span
    read
      call count-text
        read count

task main
  save root
    call open-root
      text <Term SwiftUI>
      code 420
      code 320
  call board
    read root
  call after-launch
    task check
      call show-window
      save stepper
        call child-at
          read root
          code 0
      save progress
        call child-at
          read root
          code 1
      save stepper-name
        call hosted-name
          read stepper
      save progress-name
        call hosted-name
          read progress
      save start
        call serialize
          read root
      call say
        text <step start {{stepper-name}} {{progress-name}} {{start}}>
      call perform-hosted
        read stepper
        text <increment>
      call perform-hosted
        read stepper
        text <increment>
      call later
        task after
          save handed
            call hosted-attribute
              read stepper
              text <value>
          save shown
            call serialize
              call child-at
                read root
                code 2
          call say
            text <step pressed {{handed}} {{shown}}>
          call snapshot
            text <${shot}>
          call exit-app
            code 0
  call run-app
`

// the text after `step <name> `
function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

// every `<swiftui name=".." size="w,h">` the tree read back holds, with its size
function hosted(tree: string): { name: string; width: number; height: number }[] {
  return [...tree.matchAll(/<swiftui name="([^"]*)" size="(\d+),(\d+)">/g)].map(m => ({ name: m[1]!, width: Number(m[2]), height: Number(m[3]) }))
}

function judge(leg: Leg, toolkit: string, output: string): void {
  if (leg === 'android') {
    return
  }

  const start = step(output, 'start')
  ok(`${leg}: both SwiftUI views are installed in the tree (${toolkit})`, start.startsWith('stepper progress '), start.slice(0, 200))
  const views = hosted(start)
  ok(
    `${leg}: SwiftUI laid each one out to a size above zero`,
    views.length === 2 && views.every(v => v.width > 0 && v.height > 0) && views[0]!.name === 'stepper' && views[1]!.name === 'progress',
    JSON.stringify(views),
  )
  const pressed = step(output, 'pressed')
  ok(`${leg}: two presses reached the program's handler, and the count went back into the stepper's input`, pressed.startsWith('2 '), pressed)
  ok(`${leg}: the span the program draws reads the count`, pressed.includes('2'), pressed)
}

// Apple only: on Android the slot is Compose's (compose-target)
for (const leg of process.env.SWIFTUI_ONLY ? [process.env.SWIFTUI_ONLY] : ['macos', 'ios']) {
  runToolkits(
    {
      root: process.cwd(),
      dir: mkdtempSync(join(tmpdir(), 'term-toolkit-swiftui-')),
      // not `SwiftUI`: the iOS build names the app's module after it, and `SwiftUI.View` would then be the app's own
      name: 'Hosted',
      iosIdentifier: 'surf.term.toolkit-swiftui-test',
      androidIdentifier: 'surf.term.toolkitswiftui',
      program,
      judge,
      ok,
      shots: {},
    },
    leg,
  )
}

console.log(`\ntoolkit-swiftui: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
