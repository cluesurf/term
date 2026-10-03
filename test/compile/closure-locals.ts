// A closure's locals and its writes to outer names (native-dom-0021, 0047). Two defects, one program:
//
//   0021  a list made inside a closure kept a raw inference variable, because the checker's final resolution pass did
//         not descend into closures: Swift spelled it `SeedList<Any>`, Kotlin `mutableListOf<Any>()`, where the same code
//         at the top of a task was `<String>`, and passing it on failed to build
//   0047  the optimizer's analysis of which names are never reassigned did not look inside closures either, so a
//         closure's `save total` of an outer `total` went unseen: the first value was propagated over the write, which
//         emitted `0 = ...` on Swift and Kotlin and, on TypeScript, compiled and silently returned the stale 0
//
// The program is run as TypeScript (the value must be the written one) and built and run with swiftc.
// Run: npx tsx test/compile/closure-locals.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { nativePrelude } from '@term/make/code/compile/native'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
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

const PROGRAM = `load @term/base/code/list
  find list

task count-names
  take names
    like list
      like text
  like number
  send back, read names/length

task in-closure
  take body
    like task
  call body

task run
  like number
  save total, code 0
  call in-closure
    task inner
      save names
        make list
      call push
        bind list, read names
        bind item, text <a>
      call push
        bind list, read names
        bind item, text <b>
      save total
        call count-names
          read names
  send back, read total
`

const ROOT = process.cwd()
const dir = mkdtempSync(join(tmpdir(), 'term-closure-locals-'))
const readRuntime = (file: string): string | undefined => (existsSync(file) ? readFileSync(file, 'utf8') : undefined)

function build(env: 'node' | 'swift') {
  const entry = join(dir, `${env}.tree`)
  writeFileSync(entry, PROGRAM)

  return compile({ file: entry, text: PROGRAM }, { resolve: projectResolver(ROOT, env), env })
}

// TypeScript: the optimized program returns the value the closure wrote
{
  const result = build('node')
  ok('the program compiles', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

  if (result.ok) {
    ok('the closure writes the outer total, no literal on the left', !/\b\d+\s*=\s*countNames/.test(result.typescript), result.typescript.slice(0, 300))
    const file = join(dir, 'run.ts')
    writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
    const run = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
    ok('typescript: run answers the 2 the closure wrote, not the stale 0', run.stdout.trim() === '2', run.stdout + run.stderr)
  }
}

// Swift and Kotlin: the closure's list is typed, and the write is to the variable
{
  const result = build('swift')

  if (result.ok) {
    const swift = emitSwift(result.program)
    const kotlin = emitKotlin(result.program)
    ok('swift: the closure\'s list is SeedList<String>', /SeedList<String>\(\[\]\)/.test(swift) && !/SeedList<Any>\(\[\]\)/.test(swift))
    ok('kotlin: the closure\'s list is mutableListOf<String>()', kotlin.includes('mutableListOf<String>()') && !kotlin.includes('mutableListOf<Any>()'))

    if (spawnSync('swiftc', ['--version']).status === 0) {
      const file = join(dir, 'run.swift')
      writeFileSync(file, ['import Foundation', nativePrelude(result.program, 'swift', readRuntime, swift), swift, 'print(run())', ''].join('\n'))
      const exe = join(dir, 'run')

      try {
        execFileSync('swiftc', ['-o', exe, file], { stdio: 'pipe' })
        const run = spawnSync(exe, [], { encoding: 'utf8' })
        ok('swift: it builds and answers 2', run.stdout.trim() === '2', run.stdout + run.stderr)
      } catch (error) {
        const text = String((error as { stderr?: Buffer }).stderr ?? error)
        ok('swift: it builds and answers 2', false, text.split('\n').filter(l => /error:/.test(l)).join('\n').slice(0, 600))
      }
    } else {
      console.log('skip  swift build  (no swiftc)')
    }
  } else {
    ok('the program compiles for swift', false, result.diagnostics.map(d => d.message).join(' | '))
  }
}

// native-text-0003: two closures in one task that each `save` the same name. Each is its own scope, so each declares
// it: the bridge used to let the first closure's `save` leak into the task, which turned the second closure's `save`
// into an assignment to a local it cannot see, and every read of it failed as "not defined"
{
  const SIBLINGS = `task in-closure
  take body
    like task
  call body

task run
  like number
  save total, code 0
  call in-closure
    task first
      save seen, code 3
      save total
        call add
          read total
          read seen
  call in-closure
    task second
      save seen, code 4
      save total
        call add
          read total
          read seen
  send back, read total
`
  const entry = join(dir, 'siblings.tree')
  writeFileSync(entry, SIBLINGS)
  const result = compile({ file: entry, text: SIBLINGS }, { resolve: projectResolver(ROOT, 'node'), env: 'node' })
  ok('two closures that each save the same name both compile', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

  if (result.ok) {
    const file = join(dir, 'siblings.ts')
    writeFileSync(file, `${nativePrelude(result.program, 'node', readRuntime, result.typescript)}\n${result.typescript}\nconsole.log(run())\n`)
    const run = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
    ok('each closure\'s name is its own, and both still write the outer total: 3 + 4', run.stdout.trim() === '7', run.stdout + run.stderr)
  }
}

console.log(`\nclosure-locals: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
