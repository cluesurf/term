// The portable keyboard (swiftui-target-0003, `listen-key` in deck/site/code/dom/native/dom.tree): every key pressed in
// the window reaches each listener under the web's KeyboardEvent.key name, and face's dismissal closes an overlay on
// Escape through it rather than through the browser's KeyboardEvent. The program runs in the terminal host, so the
// keys come from the terminal's own (`press-key`, translated by `web-key`): a listener records the keys it hears, and a
// face disclosure armed with `arm-dismiss` must close on Escape. It runs on TypeScript, Rust, Swift and Kotlin.
// Run: npx tsx test/view/listen-key.ts   (KEY_ONLY=rust for one backend)

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

// the keys pressed, as the terminal names them, and the web names the listener must hear for them
const PRESSED = ['a', 'up', 'enter', 'escape']
const HEARD = 'a ArrowUp Enter Escape'

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal
  find make-root

load @term/site/code/dom/native/terminal/dom
  find create-element
  find listen-key
  find press-key

load @term/face/logic/disclosure
  find make-disclosure
  find disclosure-open

load @term/face/logic/dismiss
  find arm-dismiss

load @term/base/text/string
  find concat

form heard
  mark shared
  link keys, like text

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  save log
    make heard
      bind keys, text <>
  save drop
    call listen-key
      task hear
        take key, like text
        fork test
          hook test
            call is-equal
              read log/keys
              text <>
          hook hold
            save log/keys, read key
          hook miss
            save log/keys
              call concat
                call concat
                  read log/keys
                  text < >
                read key
  save panel
    call make-disclosure
      bind start, true
  save scope
    call make-root
      task arm
        call arm-dismiss
          read panel
  save before, text <closed>
  fork test
    hook test
      call disclosure-open
        bind self, read panel
    hook hold
      save before, text <open>
${PRESSED.map(key => `  call press-key\n    read root\n    text <${key}>`).join('\n')}
  save after, text <closed>
  fork test
    hook test
      call disclosure-open
        bind self, read panel
    hook hold
      save after, text <open>
  save keys, read log/keys
  send back, text <{keys}|{before}|{after}>
`

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/terminal/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-listen-key-'))
const only = process.env.KEY_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'keys' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: the keyboard program compiles, builds and runs`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const [keys, before, after] = ran.output.split('|')
    ok(`${backend}: every key reaches the listener under its web name`, keys === HEARD, `got ${JSON.stringify(keys)}`)
    ok(`${backend}: an armed disclosure is open before Escape and closed after it`, before === 'open' && after === 'closed', `${before} then ${after}`)
  }
}

console.log(`\nlisten-key: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
