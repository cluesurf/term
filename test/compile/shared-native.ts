// `mark shared` on the native backends (native-dom-0001): a form that says it is ONE object is seen and written
// through every binding of it. A program binds one tally twice, bumps it through each binding and through a task
// parameter, and must read 2. Swift's forms are structs and Rust's are values, so without `mark shared` the same
// program reads 0 there, which is the negative control: it proves the test can tell a reference from a copy.
// Kotlin's forms are classes already and read 2 either way. Rust lowers a shared form to an `Rc<RefCell<..>>`
// handle (optimize-0042, 2026-10-02). `note shared`, the spelling from before `note` became text, still reads.
// SN_ONLY=swift (or kotlin, rust) runs one backend. Run: npx tsx test/compile/shared-native.ts

import { runDir } from './run-dir'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitTypeScript } from '@term/make/code/compile/typescript'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import type { Program } from '@term/make/code/compile/node'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

function skipped(name: string, why: string): void {
  skip++
  console.log(`skip  ${name}  (${why})`)
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

// one tally, two bindings, bumped once through each: one object reads 2, two copies leave the original at 0
const program = (shared: boolean): string => `form tally
${shared ? '  mark shared\n' : ''}  link count, like number

task bump
  take t, like tally
  save t/count
    call add
      read t/count
      code 1

task run
  like number
  save a
    make tally
      bind count, code 0
  save b, read a
  call bump
    read b
  call bump
    read a
  send back, read a/count
`

function frontEnd(shared: boolean): Program {
  const parsed = parse({ file: 'main.tree', text: program(shared) })

  if (!parsed.ok) {
    throw new Error(`parse: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
  }

  const built = mill(expandTemplates(parsed.tree), 'main.tree')

  if (!built.ok) {
    throw new Error(`mill: ${built.diagnostics.map(d => d.message).join(', ')}`)
  }

  const out = built.program
  extendForms(out, 'main.tree')
  disambiguateOverloads(out)
  resolveNames(out, 'main.tree')
  const errors = check(out, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check: ${errors.map(d => d.message).join(' | ')}`)
  }

  resolveAsync(out)

  return simplify(out, new Set(['run', 'bump']))
}

const dir = runDir('term-shared-native-')
const only = process.env.SN_ONLY ?? ''

// the mill must carry the note onto the form, and only when it is written
{
  const marked = frontEnd(true).find(n => n.form === 'record-type' && n.name === 'tally')
  const plain = frontEnd(false).find(n => n.form === 'record-type' && n.name === 'tally')
  ok('mill: `mark shared` sets shared on the form', marked?.form === 'record-type' && marked.shared === true)
  ok('mill: a form without it is not shared', plain?.form === 'record-type' && plain.shared === undefined)
}

function build(label: string, args: string[]): boolean {
  try {
    execFileSync(args[0], args.slice(1), { stdio: 'pipe' })

    return true
  } catch (e) {
    ok(`${label} builds`, false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600))

    return false
  }
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: shared', 'swiftc not installed')
  }

  for (const shared of [true, false]) {
    const source = emitSwift(frontEnd(shared))
    const label = `swift (${shared ? 'shared' : 'value'})`

    ok(
      `${label}: the form is a ${shared ? 'final class' : 'struct'}`,
      source.includes(shared ? 'final class Tally' : 'struct Tally'),
      source.slice(0, 300),
    )

    const main = join(dir, `main-${shared}.swift`)
    writeFileSync(main, `${source}\nprint(run())\n`)

    if (!build(label, ['swiftc', '-o', join(dir, `swift-${shared}`), main])) {
      continue
    }

    const result = spawnSync(join(dir, `swift-${shared}`), [], { encoding: 'utf8' })
    const want = shared ? '2' : '0'
    ok(
      `${label}: reads ${want}`,
      result.status === 0 && result.stdout.trim() === want,
      `exit ${result.status}: ${(result.stdout + result.stderr).slice(0, 200)}`,
    )
  }
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: shared', 'kotlinc/java not installed')
  }

  const source = emitKotlin(frontEnd(true))
  const file = join(dir, 'main.kt')
  writeFileSync(file, hoistKotlinImports(`${source}\nfun main() { println(run()) }\n`))
  const jar = join(dir, 'main.jar')

  if (!build('kotlin (shared)', ['kotlinc', file, '-include-runtime', '-d', jar])) {
    return
  }

  const result = spawnSync('java', ['-jar', jar], { encoding: 'utf8' })
  ok(
    'kotlin (shared): reads 2',
    result.status === 0 && result.stdout.trim() === '2',
    `exit ${result.status}: ${(result.stdout + result.stderr).slice(0, 200)}`,
  )
}

// Rust: a shared form is an `Rc<RefCell<..>>` handle, so both bindings and the parameter reach one object and read
// 2. Without it a form is a value, every binding a copy, and the original reads 0: the negative control
function runRust(): void {
  if (!have('rustc')) {
    return skipped('rust: shared', 'rustc not installed')
  }

  for (const shared of [true, false]) {
    const source = emitRust(frontEnd(shared))
    const label = `rust (${shared ? 'shared' : 'value'})`

    ok(
      `${label}: the form is ${shared ? 'a TermShared handle' : 'a plain struct'}`,
      shared ? source.includes('TermShared<Tally>') : !source.includes('TermShared<Tally>'),
      source.slice(0, 300),
    )

    const main = join(dir, `main-${shared}.rs`)
    writeFileSync(main, `${source}\nfn main() { println!("{}", run()); }\n`)

    if (!build(label, ['rustc', '-A', 'warnings', '-o', join(dir, `rust-${shared}`), main])) {
      continue
    }

    const result = spawnSync(join(dir, `rust-${shared}`), [], { encoding: 'utf8' })
    const want = shared ? '2' : '0'
    ok(
      `${label}: reads ${want}`,
      result.status === 0 && result.stdout.trim() === want,
      `exit ${result.status}: ${(result.stdout + result.stderr).slice(0, 200)}`,
    )
  }
}

// TypeScript's forms are objects, so one is one object already: the emitted module runs under tsx and reads 2
function runTypeScript(): void {
  const file = join(dir, 'main.ts')
  writeFileSync(file, `${emitTypeScript(frontEnd(true))}\nconsole.log(run())\n`)
  const result = spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
  ok(
    'typescript (shared): reads 2',
    result.status === 0 && result.stdout.trim() === '2',
    `exit ${result.status}: ${(result.stdout + result.stderr).slice(0, 300)}`,
  )
}

if (!only || only === 'rust') {
  runRust()
}

if (!only || only === 'typescript') {
  runTypeScript()
}

if (!only || only === 'swift') {
  runSwift()
}

if (!only || only === 'kotlin') {
  runKotlin()
}

console.log(`\nshared-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
