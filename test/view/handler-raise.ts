// A raise that escapes an event handler reaches the UI and ends nothing (swiftui-target-0003): the view lowering guards
// every handler (compile/view-lower.ts) and hands what it caught to the render runtime's `keep-raise`, and `last-raise`
// reads its note reactively. Before, a raise in a click handler ended the program on Swift (`try!` in the closure) and
// on Kotlin (an exception out of the listener). The program clicks a button whose handler raises, then one that counts,
// and draws the count and the last raise. It runs on TypeScript, Rust, Swift and Kotlin over the memory host, and
// every backend must survive the raise, show its note, and keep handling clicks.
// Run: npx tsx test/view/handler-raise.ts   (RAISE_ONLY=rust for one backend)

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

// before any click, after the raising one, after the counting one: the count, then the last raise's note
const WANT = [
  '<main><button>refuse</button><button>count</button><span>0</span><span></span></main>',
  '<main><button>refuse</button><button>count</button><span>0</span><span>no more</span></main>',
  '<main><button>refuse</button><button>count</button><span>1</span><span>no more</span></main>',
].join('|')

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event
  find last-raise

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find child-at
  find fire
  find serialize

task refuse
  halt <no more>

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

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call board
    read root
  save before
    call serialize
      read root
  call fire
    call child-at
      read root
      code 0
    text <click>
  save raised
    call serialize
      read root
  call fire
    call child-at
      read root
      code 1
    text <click>
  save after
    call serialize
      read root
  send back, text <{before}|{raised}|{after}>
`

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|device|view)$/, 'native/memory/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-handler-raise-'))
const only = process.env.RAISE_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const ran = runOn({ backend, program: PROGRAM, resolve: pinned, dir, name: 'raise' })

  if (ran.form === 'skipped') {
    console.log(`skip  ${backend}: ${ran.reason}`)
    continue
  }

  ok(`${backend}: a handler that raises compiles, builds, and the program runs to its end`, ran.form === 'ran', ran.form === 'failed' ? `${ran.stage}: ${ran.reason}` : '')

  if (ran.form === 'ran') {
    const [before, raised, after] = ran.output.split('|')
    const [wantBefore, wantRaised, wantAfter] = WANT.split('|')
    ok(`${backend}: nothing raised before any click`, before === wantBefore, `got ${JSON.stringify(before)}`)
    ok(`${backend}: the raise's note reaches the view`, raised === wantRaised, `got ${JSON.stringify(raised)}`)
    ok(`${backend}: the next click is still handled`, after === wantAfter, `got ${JSON.stringify(after)}`)
  }
}

console.log(`\nhandler-raise: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
