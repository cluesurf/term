// Disposal frees native views (reactive-bridge-0005): a `show` swaps between a branch of five buttons, each with a click
// listener, and a span, forty times, on AppKit (macOS), UIKit (the iPhone simulator), Android views (the emulator),
// Compose on the desktop JVM and Jetpack Compose (the emulator). The host counts the nodes still alive (`live-nodes`:
// Swift counts in `init` and `deinit`, Kotlin by weak references after a collection, which on Compose also proves the
// composition let go of every node it drew). After two swaps the program has made both branches once; after forty it
// has made each twenty times, so a branch whose views outlive their disposal shows as nineteen copies more. The count
// must stay flat. LEAK_ONLY=macos (or ios, android, compose, compose-android) runs one platform. Run: npx tsx test/compile/toolkit-leak.ts

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

const SWAPS = 40

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
  find say
  find later
  find live-nodes

task is-on
  take flag, like signal boolean
  like boolean
  send back
    call read-signal
      bind self, read flag

task flip
  take flag, like signal boolean
  call write-signal
    bind self, read flag
    bind value
      call is-equal
        call is-on
          read flag
        false

view board
  take host, like view
  take flag, like signal boolean
  fork test
    hook test
      call is-on
        read flag
    hook hold
      view div
        view button
          hook click
            call flip
              read flag
          text <one>
        view button
          hook click
            call flip
              read flag
          text <two>
        view button
          hook click
            call flip
              read flag
          text <three>
        view button
          hook click
            call flip
              read flag
          text <four>
        view button
          hook click
            call flip
              read flag
          text <five>
    hook miss
      view span
        text <off>

task main
  save flag
    call make-signal
      bind value, true
  save root
    call open-root
      text <Term leak>
      code 320
      code 240
  call board
    read root
    read flag
  call after-launch
    task check
      call show-window
      call flip
        read flag
      call flip
        read flag
      call later
        task warm
          save early
            call live-nodes
          walk size
            bind base, code 2
            bind head, code ${SWAPS}
            hook next
              take site, name step
              call flip
                read flag
          call later
            task settled
              save late
                call live-nodes
              call say
                text <step live {{early}} {{late}}>
              call exit-app
                code 0
  call run-app
`

function step(output: string, name: string): string {
  const line = output.split('\n').find(l => l.includes(`step ${name} `)) ?? ''

  return line.slice(line.indexOf(`step ${name} `) + `step ${name} `.length).trim()
}

function judge(leg: Leg, toolkit: string, output: string): void {
  const [early, late] = step(output, 'live').split(' ').map(Number)
  console.log(`      ${leg}: ${early} nodes alive after 2 swaps, ${late} after ${SWAPS}`)
  ok(
    `${leg}: forty swaps of a five button branch leave as many nodes alive as two did (${toolkit})`,
    Number.isFinite(early) && Number.isFinite(late) && early! > 0 && late! <= early! + 1,
    `after 2 swaps ${early}, after ${SWAPS} ${late}`,
  )
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-leak-')),
    name: 'Leak',
    iosIdentifier: 'surf.term.toolkit-leak-test',
    androidIdentifier: 'surf.term.toolkitleak',
    program,
    judge,
    ok,
    compose: true,
    composeAndroid: true,
    shots: {},
  },
  process.env.LEAK_ONLY ?? '',
)

console.log(`\ntoolkit-leak: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
