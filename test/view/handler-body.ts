// A view's event handler with several statements runs all of them (compile/view-lower.ts). The mill makes such a body a
// closure already, and the lowering wrapped it in a second one, so the handler BUILT the function and never called it:
// a click whose handler wrote two signals wrote neither, and nothing failed. A one-statement handler, which the
// lowering does wrap, must still run too. Found by test/view/terminal-input.ts on 2026-10-03.
// Run: npx tsx test/view/handler-body.ts

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { projectResolver } from '@term/call/code/make'
import type { Resolver } from '@term/make/code/compile/load'

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

// two buttons: `both` writes two signals in one handler, `one` writes one. Each is clicked once, and the view shows all
// three signals, so a handler that did not run leaves its zeros
const WANT = '<main><button>both</button><button>one</button><span>1-1-1</span></main>'

const PROGRAM = `load @term/site/code/view/reactive
  find make-signal
  find read-signal
  find write-signal

load @term/site/code/view/render
  find make-element
  find make-text
  find make-dynamic-text
  find attach-event

load @term/site/code/dom/dom
  find view
  find append

load @term/site/code/dom/native/memory/dom
  find create-element
  find child-at
  find fire
  find serialize

task show-all
  take a, like signal
  take b, like signal
  take c, like signal
  like text
  save x
    call read-signal
      bind self, read a
  save y
    call read-signal
      bind self, read b
  save z
    call read-signal
      bind self, read c
  send back, text <{x}-{y}-{z}>

view board
  take host, like view
  save a
    call make-signal
      bind value, code 0
  save b
    call make-signal
      bind value, code 0
  save c
    call make-signal
      bind value, code 0
  view button
    seed click
      call write-signal
        bind self, read a
        bind value, code 1
      call write-signal
        bind self, read b
        bind value, code 1
    text <both>
  view button
    seed click
      call write-signal
        bind self, read c
        bind value, code 1
    text <one>
  view span
    read
      call show-all
        read a
        read b
        read c

task run
  like text
  save root
    call create-element
      bind tag, text <main>
  call board
    read root
  call fire
    call child-at
      read root
      code 0
    text <click>
  call fire
    call child-at
      read root
      code 1
    text <click>
  send back
    call serialize
      read root
`

function pinned(env: string): Resolver {
  const base = projectResolver(process.cwd(), env)

  return (importPath, fromFile) => base(importPath.replace(/native\/\{platform\}\/(dom|view)$/, 'native/memory/$1'), fromFile)
}

const dir = mkdtempSync(join(tmpdir(), 'term-handler-body-'))
const entry = join(dir, 'board.tree')
writeFileSync(entry, PROGRAM)
const result = compile({ file: entry, text: PROGRAM }, { resolve: pinned('node'), env: 'node' })
ok('the view compiles', result.ok, result.ok ? '' : [...new Set(result.diagnostics.map(d => d.message))].slice(0, 6).join(' | '))

if (result.ok) {
  ok('no handler is a closure that only builds a closure', !/=> \(\(\) =>/.test(result.typescript))
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const file = join(dir, 'board.ts')
  writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
  const ran = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  ok('both handlers run every statement they hold', ran.status === 0 && ran.stdout.trim() === WANT, `exit ${ran.status}: ${(ran.stdout + ran.stderr).slice(0, 400)}`)
}

console.log(`\nhandler-body: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
