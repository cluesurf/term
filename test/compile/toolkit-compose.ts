// Composed input on the toolkit hosts (native-text-0003): a field taking text from an input method, on AppKit (macOS),
// UIKit (the iPhone simulator) and Android views (the emulator). Three scripts word.surf edits, each typed the way its
// keyboard types it, in stages of MARKED text and then a commit, through the platform's own input method entry points
// (setMarkedText and insertText on Apple, InputConnection.setComposingText and commitText on Android):
//
//   korean     ㅎ  하  한        committed 한     Hangul: a syllable builds from its jamo
//   japanese   か  かん  かんじ   committed 漢字   kana, then the conversion
//   chinese    z  zh  zhong     committed 中     pinyin, then the character
//
// Every composition event and every `input` the field fires says what it saw: the event, the composing text and the
// field's value. The judge reads the web's order back out of that: `compositionstart`, a `compositionupdate` per marked
// stage carrying that stage's text, `compositionend` at the commit, and the committed text in the value.
// COMPOSE_ONLY=macos (or ios, android) runs one platform. Run: npx tsx test/compile/toolkit-compose.ts

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

type Script = { name: string; stages: string[]; commit: string }

const SCRIPTS: Script[] = [
  { name: 'korean', stages: ['ㅎ', '하', '한'], commit: '한' },
  { name: 'japanese', stages: ['か', 'かん', 'かんじ'], commit: '漢字' },
  { name: 'chinese', stages: ['z', 'zh', 'zhong'], commit: '中' },
]

// one script typed: a marker line, each marked stage, the commit
const typing = SCRIPTS.map(script =>
  [
    `      call say`,
    `        text <script ${script.name}>`,
    ...script.stages.flatMap(stage => [`      call compose`, `        read field`, `        text <${stage}>`]),
    `      call commit-composition`,
    `        read field`,
    `        text <${script.commit}>`,
  ].join('\n'),
).join('\n')

// a listener that says the event, the composing text and the value, each between bars
const listener = (event: string) => `  call listen
    read field
    text <${event}>
    task on-${event}
      save marked
        call composing-text
          read field
      save value
        call get-value
          read field
      call say
        text <event ${event}|{{marked}}|{{value}}|>`

const program = (_leg: Leg, shot: string): string => `load @term/site/code/dom/dom
  find view

load @term/site/code/dom/native/toolkit/dom
  find open-root
  find after-launch
  find show-window
  find run-app
  find exit-app
  find create-element
  find append
  find listen
  find get-value
  find composing-text
  find compose
  find commit-composition
  find snapshot
  find say

task main
  save root
    call open-root
      text <Term compose>
      code 420
      code 200
  save field
    call create-element
      text <input>
  call append
    read root
    read field
${listener('compositionstart')}
${listener('compositionupdate')}
${listener('compositionend')}
${listener('input')}
  call after-launch
    task check
      call show-window
${typing}
      call say
        text <script done>
      call snapshot
        text <${shot}>
      call exit-app
        code 0
  call run-app
`

type Event = { event: string; marked: string; value: string }

// the events said between one script's marker and the next
function eventsOf(output: string, name: string): Event[] {
  const lines = output.split('\n')
  const start = lines.findIndex(line => line.includes(`script ${name}`))
  const end = lines.findIndex((line, i) => i > start && line.includes('script '))
  const events: Event[] = []

  for (const line of lines.slice(start + 1, end < 0 ? undefined : end)) {
    const found = /event (\w+)\|([^|]*)\|([^|]*)\|/.exec(line)

    if (found) {
      events.push({ event: found[1]!, marked: found[2]!, value: found[3]! })
    }
  }

  return events
}

function judge(leg: Leg, toolkit: string, output: string): void {
  let before = ''

  for (const script of SCRIPTS) {
    const events = eventsOf(output, script.name)
    const composing = events.filter(e => e.event.startsWith('composition'))
    const names = composing.map(e => e.event)
    const updates = composing.filter(e => e.event === 'compositionupdate')
    const show = JSON.stringify(events)

    ok(
      `${leg}: ${script.name} composes in the web's order, start, an update per stage, end (${toolkit})`,
      names[0] === 'compositionstart' && names.at(-1) === 'compositionend' && names.filter(n => n === 'compositionstart').length === 1 && names.filter(n => n === 'compositionend').length === 1,
      show,
    )
    ok(
      `${leg}: ${script.name}: each update carries its stage's marked text, ${script.stages.join(' ')}`,
      updates.length === script.stages.length && updates.every((e, i) => e.marked === script.stages[i]),
      JSON.stringify(updates.map(e => e.marked)),
    )
    ok(
      `${leg}: ${script.name}: while composing, the value holds the marked text after what came before`,
      // an update per stage first: with none, `every` is true of nothing, which passed a host that saw no composition
      updates.length === script.stages.length && updates.every((e, i) => e.value === before + script.stages[i]),
      JSON.stringify(updates.map(e => e.value)),
    )
    ok(
      `${leg}: ${script.name}: an input follows each edit`,
      events.filter(e => e.event === 'input').length >= script.stages.length + 1,
      show,
    )

    const end = composing.find(e => e.event === 'compositionend')
    before += script.commit
    ok(
      `${leg}: ${script.name}: at the commit nothing is marked and the value is ${before}`,
      !!end && end.marked === '' && end.value === before,
      JSON.stringify(end),
    )
  }
}

runToolkits(
  {
    root: process.cwd(),
    dir: mkdtempSync(join(tmpdir(), 'term-toolkit-compose-')),
    name: 'Compose',
    iosIdentifier: 'surf.term.toolkit-compose-test',
    androidIdentifier: 'surf.term.toolkitcompose',
    program,
    judge,
    ok,
    shots: { macos: process.env.SNAPSHOT_COMPOSE, ios: process.env.SNAPSHOT_COMPOSE_IOS, android: process.env.SNAPSHOT_COMPOSE_ANDROID },
  },
  process.env.COMPOSE_ONLY ?? '',
)

console.log(`\ntoolkit-compose: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
