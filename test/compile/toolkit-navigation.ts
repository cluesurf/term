// The routed app on the toolkit hosts (native-navigation-0007): a route table mounted by the toolkit `host`
// (deck/site/code/view/native/toolkit/host.tree) on AppKit (macOS), UIKit (the iPhone simulator) and Android views (the
// emulator), drawn from the navigation contract, and moved by the platform's own back. The program goes to /a and /b
// through the contract, then back twice the way a person does (`press-back`: the Activity's back on Android, ⌘[ through
// the menu bar on macOS, the edge swipe's action on iOS), and says what the WINDOW draws after each step, read off the
// platform views.
// NAVIGATION_ONLY=macos (or ios, android) runs one platform. Run: npx tsx test/compile/toolkit-navigation.ts

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

load @term/site/code/dom/native/toolkit/dom
  find after-launch
  find run-app
  find exit-app
  find create-element
  find create-text
  find append
  find serialize
  find press-back
  find later
  find snapshot
  find say

load @term/site/code/view/native/toolkit/host
  find mount-app

load @term/site/code/view/navigation
  find navigate
  find current-path

# a place drawn: its path, in a span
task draw
  take host, like view
  take path, like text
  save here
    call create-element
      text <span>
  call append
    read here
    call create-text
      read path
  call append
    read host
    read here

task main
  save root
    call mount-app
      read draw
      text <Term navigation>
  call after-launch
    task check
      save start
        call serialize
          read root
      call say
        text <step start {{start}}>
      call navigate
        text </a>
      call navigate
        text </b>
      save at-b
        call serialize
          read root
      call say
        text <step b {{at-b}}>
      call press-back
      call later
        task after-first
          save first
            call serialize
              read root
          save first-path
            call current-path
          call say
            text <step back {{first-path}} {{first}}>
          call press-back
          call later
            task after-second
              save second
                call serialize
                  read root
              save second-path
                call current-path
              call say
                text <step root {{second-path}} {{second}}>
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

function judge(leg: Leg, toolkit: string, output: string): void {
  ok(`${leg}: the app mounts at / and the window draws it (${toolkit})`, step(output, 'start').includes('<span>/</span>'), step(output, 'start'))
  ok(`${leg}: navigating to /a then /b draws /b`, step(output, 'b').includes('<span>/b</span>') && !step(output, 'b').includes('<span>/a</span>'), step(output, 'b'))
  ok(`${leg}: the platform's back takes the app to /a and the window draws it`, step(output, 'back').startsWith('/a ') && step(output, 'back').includes('<span>/a</span>'), step(output, 'back'))
  ok(`${leg}: back again is the start`, step(output, 'root').startsWith('/ ') && step(output, 'root').includes('<span>/</span>'), step(output, 'root'))
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-navigation-')),
    name: 'Navigation',
    iosIdentifier: 'surf.term.toolkit-navigation-test',
    androidIdentifier: 'surf.term.toolkitnavigation',
    program,
    judge,
    ok,
    shots: {},
  },
  process.env.NAVIGATION_ONLY ?? '',
)

console.log(`\ntoolkit-navigation: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
