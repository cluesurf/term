// What a terminal sends, decoded into key names (terminal-target-0006, deck/site/code/dom/native/terminal/keys.tree).
// Each case is a byte sequence as a terminal in raw mode delivers it, written out by hand from the ECMA-48 / xterm
// conventions (ESC `[` `A` is up, ESC `[` `Z` is shift-tab, 127 is backspace), with the keys it must decode to. A
// function key's longer sequence must be consumed whole and dropped, never leaking its bytes as typed characters. It
// runs on TypeScript, Rust, Swift and Kotlin, and every backend must decode the same keys.
// Run: npx tsx test/view/terminal-keys.ts   (TERMINAL_ONLY=rust for one backend)

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

const ESC = 27

const CASES: { name: string; runes: number[]; want: string[] }[] = [
  { name: 'letters are themselves', runes: [104, 105], want: ['h', 'i'] },
  { name: 'tab, enter as 13 and as 10, space', runes: [9, 13, 10, 32], want: ['tab', 'enter', 'enter', 'space'] },
  { name: 'backspace as 127 and as 8', runes: [127, 8], want: ['backspace', 'backspace'] },
  { name: 'the four arrows', runes: [ESC, 91, 65, ESC, 91, 66, ESC, 91, 67, ESC, 91, 68], want: ['up', 'down', 'right', 'left'] },
  { name: 'shift-tab is ESC [ Z', runes: [ESC, 91, 90], want: ['shift-tab'] },
  { name: 'ESC alone is escape', runes: [ESC], want: ['escape'] },
  { name: 'ctrl-c', runes: [3], want: ['ctrl-c'] },
  { name: 'other controls are dropped', runes: [1, 104, 2], want: ['h'] },
  // F5 is ESC [ 1 5 ~: consumed to the `~`, and the letter after it still arrives
  { name: 'a function key is consumed whole and dropped', runes: [ESC, 91, 49, 53, 126, 120], want: ['x'] },
  { name: 'a character past ASCII arrives whole', runes: [233, 26085], want: ['é', '日'] },
]

// each case's runes built into a list, decoded, and joined with commas; the cases joined with `|`
const cases = CASES.map((one, i) => {
  const pushes = one.runes.map(rune => `  call push\n    bind list, read runes\n    bind item, code ${rune}`).join('\n')

  return `task case-${i}
  like text
  save runes
    call make-runes
${pushes}
  send back
    call join-keys
      call decode-keys
        read runes`
}).join('\n\n')

const PROGRAM = `load @term/site/code/dom/native/terminal/dom
  find decode-keys

load @term/base/code/list
  find list
  find push

load @term/base/text/string
  find concat

task make-runes
  like list
    like number
  send back
    make list

task join-keys
  take keys
    like list
      like text
  like text
  save joined, text <>
  save first, true
  walk list, read keys
    hook next
      take site, name key
      fork test
        hook test
          read first
        hook hold
          save first, false
        hook miss
          save joined
            call concat
              read joined
              text <,>
      save joined
        call concat
          read joined
          read key
  send back, read joined

${cases}

task run
  like text
${CASES.map((_, i) => `  save answer-${i}, call case-${i}`).join('\n')}
  send back, text <${CASES.map((_, i) => `{answer-${i}}`).join('|')}>
`

function pinned(env: string): Resolver {
  return projectResolver(process.cwd(), env)
}

const dir = mkdtempSync(join(tmpdir(), 'term-terminal-keys-'))
const only = process.env.TERMINAL_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'keys' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: the decoder compiles, builds and runs`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const answers = ran.output.split('|')

    for (const [i, one] of CASES.entries()) {
      const got = answers[i] === '' ? [] : (answers[i] ?? '').split(',')
      ok(`${backend}: ${one.name}`, JSON.stringify(got) === JSON.stringify(one.want), `got ${JSON.stringify(got)}`)
    }
  }
}

console.log(`\nterminal-keys: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
