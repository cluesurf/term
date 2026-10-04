// The accessibility contract on the toolkit hosts (native-accessibility-0007): every vocabulary word placed on the
// window of AppKit (macOS), UIKit (the iPhone simulator), Android views (the emulator), Compose on the desktop JVM and
// Jetpack Compose (the emulator), with the props that name it, and what each PLATFORM'S ACCESSIBILITY API reports for it
// read back (`accessibility-of`: AppKit's accessibilityRole and label, UIKit's traits and label, the
// AccessibilityNodeInfo a view fills in on Android, Compose's semantics tree on both Compose legs). Each role must be
// one the contract's column for that platform names (note/term/view/11-vocabulary.md, "Accessibility"), and each named
// word must carry its name. The dialog is presented by the platform rather than placed, and is not measured here.
// A11Y_ONLY=macos (or ios, android, compose, compose-android) runs one platform. Run: npx tsx test/compile/toolkit-accessibility.ts

import { mkdtempSync, readFileSync } from 'node:fs'
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

// each placed word, in placement order: which node to ask (the placed node, or its first child for a text, whose
// label is the child) and the name it must carry
type Case = { word: string; what: string; inner: boolean; name?: string }

const CASES: Case[] = [
  { word: 'text', what: 'plain text', inner: true, name: 'plain' },
  { word: 'text', what: 'text with a level', inner: true, name: 'Title' },
  { word: 'image', what: 'an image with words', inner: false, name: 'A dot' },
  { word: 'image', what: 'an image with none', inner: false },
  { word: 'field', what: 'a field', inner: false, name: 'Your name' },
  { word: 'button', what: 'a button', inner: false, name: 'Save' },
  { word: 'stack', what: 'a stack', inner: false },
  { word: 'scroll', what: 'a scroll', inner: false },
  { word: 'spacer', what: 'a spacer', inner: false },
  { word: 'divider', what: 'a divider', inner: false },
  { word: 'frame', what: 'a frame', inner: false },
  { word: 'toggle', what: 'a toggle', inner: false, name: 'Wi-Fi' },
  { word: 'range', what: 'a range', inner: false, name: 'Volume' },
  { word: 'choice', what: 'a choice', inner: false, name: 'Size' },
]

const report = CASES.map((one, i) => {
  const node = one.inner ? `          call child-at\n            call child-at\n              read root\n              code ${i}\n            code 0` : `          call child-at\n            read root\n            code ${i}`

  return `      save said-${i}
        call accessibility-of
${node}
      call say
        text <a11y ${i}|{{said-${i}}}|>`
}).join('\n')

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find child-at
  find accessibility-of
  find snapshot
  find say

load @term/site/code/view/reactive
  find make-signal

load @term/face/code/logic/disclosure
  find make-disclosure

load @term/face/code/logic/range
  find make-range

load @term/base/code/list
  find list
  find push

load @term/face/code/component/stack
  find stack
load @term/face/code/component/text
  find text
load @term/face/code/component/spacer
  find spacer
load @term/face/code/component/divider
  find divider
load @term/face/code/component/image
  find image
load @term/face/code/component/frame
  find frame
load @term/face/code/component/scroll
  find scroll
load @term/face/code/component/switch
  find switch
load @term/face/code/component/slider
  find slider
load @term/face/code/component/select
  find select

view still
  take host, like view
  view text
    bind content, text <plain>
  view text
    bind content, text <Title>
    bind level, code 2
  view image
    bind source, text <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC>
    bind text, text <A dot>
  view image
    bind source, text <data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC>
  view input
    bind placeholder, text <Your name>
  view button
    text <Save>
  view stack
    view text
      bind content, text <in a stack>
  view scroll
    bind style, text <height: 40px>
    view text
      bind content, text <in a scroll>
  view spacer
  view divider
  view frame
    bind width, code 100
    view text
      bind content, text <in a frame>

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
    bind item, text <large>
  send back, read names

task main
  save root
    call open-root
      text <Term accessibility>
      code 420
      code 900
  call still
    read root
  call switch
    read root
    text <>
    call make-disclosure
      bind start, false
    text <Wi-Fi>
  call slider
    read root
    text <>
    call make-range
      bind start, code 40.0
    code 0.0
    code 100.0
    code 1.0
    text <Volume>
  call select
    read root
    text <>
    call make-signal
      bind value, text <small>
    call size-names
    text <Size>
  call after-launch
    task check
      call show-window
${report}
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

// the contract's column per platform: the cell for each word
const note = readFileSync(join(process.cwd(), '../../../../note/term/view/11-vocabulary.md'), 'utf8')
const table = note.slice(note.indexOf('## Accessibility'), note.indexOf('## The layout model'))
const rows = new Map(
  table
    .split('\n')
    .map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
    .filter(cells => cells.length === 10)
    .map(cells => [cells[0]!, cells] as const),
)
// both Compose legs read one column: Compose's semantics, from which each platform's bridge is made
const COLUMN: Record<Leg, number> = { macos: 2, ios: 3, android: 4, compose: 5, 'compose-android': 5 }

// the cell allows this role: every part of it named in backticks, `none` for an empty role, `hidden` for one out of the tree
function allows(leg: Leg, word: string, role: string): boolean {
  const cell = rows.get(word)?.[COLUMN[leg]] ?? ''

  if (role === '') {
    return /(^|[ (;])none\b/.test(cell)
  }

  return role.split('+').every(part => cell.includes(`\`${part}\``))
}

function judge(leg: Leg, toolkit: string, output: string): void {
  for (const [i, one] of CASES.entries()) {
    const line = output.split('\n').find(l => l.includes(`a11y ${i}|`)) ?? ''
    const found = /a11y \d+\|([^|]*)\|([^|]*)\|/.exec(line)

    if (!found) {
      ok(`${leg}: ${one.what}: reported (${toolkit})`, false, line)
      continue
    }

    const [, role, name] = found
    ok(`${leg}: ${one.what}: the platform's role ${role || '(none)'} is the contract's`, allows(leg, one.word, role!), `${rows.get(one.word)?.[COLUMN[leg]] ?? 'no row'} | said: ${line.trim()}`)

    if (one.name !== undefined) {
      ok(`${leg}: ${one.what}: named ${one.name}`, name === one.name, name ?? '')
    }
  }
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-accessibility-')),
    name: 'Accessible',
    iosIdentifier: 'surf.term.toolkit-accessibility-test',
    androidIdentifier: 'surf.term.toolkitaccessible',
    program,
    judge,
    ok,
    compose: true,
    composeAndroid: true,
    shots: {},
  },
  process.env.A11Y_ONLY ?? '',
)

console.log(`\ntoolkit-accessibility: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
