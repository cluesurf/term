// A native runtime's namespace never takes a name a Term module defines (native-dom-0042). The stdlib's string runtime
// was `enum text` on Swift (`object text` on Kotlin, `mod text` on Rust), and the render runtime then had a task `text`,
// so a program that reached both, face's select joining its options with text/util's `join`, failed swiftc with
// `invalid redeclaration of 'text'`. It is `strings` now. The render task is `make-text` since tasks became verbs, so
// the program here defines the noun itself, a `view text` component like the vocabulary's word, and places it beside
// text/util's `join`: the collision stays exercised. Skips without swiftc. Run: npx tsx test/compile/runtime-names.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { projectResolver } from '@term/call/code/make'

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

if (spawnSync('swiftc', ['--version']).status !== 0) {
  console.log('skip  runtime-names  (no swiftc)')
  process.exit(0)
}

// a Term `text` (a component) and text/util's `join` (the string runtime) in one program
const PROGRAM = `load @term/site/code/view/render
  find make-element
  find make-text

load @term/site/code/dom/native/memory/dom
  find view
  find serialize
  find append

# the noun a Swift runtime namespace must not redeclare: a component, as the view vocabulary's word is
view text
  take host, like view
  take content, like text
  view span
    read content

load @term/base/code/text/util
  find join

load @term/base/code/list
  find list

task names
  like list
    like text
  save all
    make list
  call push
    bind list, read all
    bind item, text <a>
  call push
    bind list, read all
    bind item, text <b>
  send back, read all

task run
  like text
  save root
    call make-element
      text <main>
  call text
    read root
    call join
      call names
      text <,>
  send back
    call serialize
      read root
`

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-runtime-names-'))
const entry = join(dir, 'names.tree')
writeFileSync(entry, PROGRAM)
// the dom is the memory host, so the tree can be printed
const base = projectResolver(ROOT, 'swift')
const resolve = (importPath: string, fromFile: string) =>
  base(importPath.replace(/dom\/native\/\{platform\}\/dom$/, 'dom/native/memory/dom'), fromFile)
const result = compile({ file: entry, text: PROGRAM }, { resolve, env: 'swift' })
ok('the program compiles for swift', result.ok, result.ok ? '' : result.diagnostics.slice(0, 3).map(d => d.message).join(' | '))

if (result.ok) {
  const swift = emitSwift(result.program)
  const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)
  const prelude = nativePrelude(result.program, 'swift', readRuntime, swift)
  ok('the string runtime is in it, as `strings`', prelude.includes('enum strings'))
  const file = join(dir, 'names.swift')
  writeFileSync(file, ['import Foundation', prelude, swift, 'print(run())', ''].join('\n'))
  const exe = join(dir, 'names')

  try {
    execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
    ok('swiftc builds it: no redeclaration of text', true)
    const run = spawnSync(exe, [], { encoding: 'utf8' })
    ok('it runs, the joined text in the `text` component', run.stdout.trim() === '<main><span>a,b</span></main>', run.stdout + run.stderr)
  } catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? error)
    ok('swiftc builds it: no redeclaration of text', false, text.split('\n').filter(l => /error:/.test(l)).join('\n').slice(0, 800))
  }
}

console.log(`\nruntime-names: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
