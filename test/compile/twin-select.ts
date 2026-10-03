// The selection pass (ir/twin.ts, optimize-0008): a chosen twin really runs in place of its task, on every backend,
// and answers what the task answers.
//
// `count-each` in @term/base/code/count has two twins. Each choice is built and run on TypeScript, Rust, Swift and
// Kotlin and must print the reference's answers: the reference, `tally`, `dense` (behind its `hook test`), and a
// size check between the two. `dense` on values OUTSIDE its range is the guard's own test: chosen without its check,
// it writes past its 65,536 slots, so a correct answer there is the check sending the call to the reference.
// TS_ONLY=rust (or swift, kotlin, typescript) runs one backend. Run: npx tsx test/compile/twin-select.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { nativeFlags } from './native-flags'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { TwinChoices } from '@term/make/code/ir/twin'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

function have(tool: string): boolean {
  return spawnSync('which', [tool]).status === 0
}

const base = join(import.meta.dirname, '../../deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

// two calls: one from `compute`, one from a task of its own, so the redirect is seen in more than one place
const PROGRAM = `load @term/base/code/count
  find count-each

load @term/base/code/list
  find list

task listed
  take a, like number
  take b, like number
  take c, like number
  take d, like number
  like list, like number
  save out
    make list
  call push
    bind list, read out
    bind item, read a
  call push
    bind list, read out
    bind item, read b
  call push
    bind list, read out
    bind item, read c
  call push
    bind list, read out
    bind item, read d
  send back, read out

task summed
  take counts, like list, like number
  like number
  save total, code 0
  save weight, code 1
  walk list, read counts
    hook next
      take site, name n
      save total
        call add
          read total
          call multiply
            read n
            read weight
      save weight
        call multiply
          read weight
          code 10
  send back, read total

task twice
  like number
  send back
    call summed
      call count-each
        call listed
          code 70000
          code 2
          code 70000
          code -1
        call listed
          code 70000
          code -1
          code 5
          code 2

task compute
  like text
  host small
    call summed
      call count-each
        call listed
          code 5
          code 3
          code 5
          code 9
        call listed
          code 5
          code 7
          code 3
          code 9
  host wide
    call twice
  send back, text <small={{small}} wide={{wide}}>
`

// in range: 5 twice, 7 never, 3 once, 9 once -> 2,0,1,1 -> 2 + 0 + 100 + 1000. Out of range: 70000 twice, -1 once,
// 5 never, 2 once -> 2,1,0,1 -> 2 + 10 + 0 + 1000
const WANT = 'small=1102 wide=1012'

const CHOICES: [string, TwinChoices][] = [
  ['the reference', { 'count-each': 'reference' }],
  ['tally', { 'count-each': { use: 'tally' } }],
  ['dense, behind its check', { 'count-each': { use: 'dense' } }],
  ['a size check: tally below 3 values, dense from there', { 'count-each': { check: 'size', of: 'values', below: 3, then: { use: 'tally' }, else: { use: 'dense' } } }],
]

const dir = mkdtempSync(join(tmpdir(), 'twin-select-'))
const only = process.env.TS_ONLY ?? ''

function build(env: string, choices: TwinChoices) {
  const resolve = env === 'typescript' ? stdlib : withNativeEnv(env as 'rust', stdlib)

  return compile({ file: join(dir, 'main.tree'), text: PROGRAM }, { resolve, twins: choices, ...(env === 'typescript' ? {} : { env }) })
}

function run(env: string, label: string, choices: TwinChoices, index: number): void {
  const name = `${env}: ${label}`
  const built = build(env, choices)

  if (!built.ok) {
    ok(name, false, built.diagnostics.map(d => d.message).join(' | ').slice(0, 600))

    return
  }

  const chose = Object.values(choices)[0] !== 'reference'

  if (chose && index === 1 && env === 'typescript') {
    // the call was redirected to the dispatch, and the dispatch calls the twin
    ok('the call to count-each goes through the dispatch', /countEachChosen\(|count_each_chosen\(/.test(built.typescript), built.typescript.slice(0, 200))
  }

  try {
    let out: string

    if (env === 'typescript') {
      const file = join(dir, `main-${index}.ts`)
      writeFileSync(file, `${built.typescript}\nprocess.stdout.write(String(compute()))\n`)
      out = execFileSync('npx', ['tsx', file], { stdio: ['ignore', 'pipe', 'pipe'] }).toString()
    } else if (env === 'rust') {
      const file = join(dir, `main-${index}.rs`)
      writeFileSync(file, `${nativePrelude(built.program, 'rust', readRuntime)}\n${emitRust(built.program)}\nfn main() { print!("{}", compute()); }\n`)
      execFileSync('rustc', ['-A', 'warnings', '-O', file, '-o', join(dir, `rs-${index}`)], { stdio: ['ignore', 'pipe', 'pipe'] })
      out = execFileSync(join(dir, `rs-${index}`)).toString()
    } else if (env === 'swift') {
      const file = join(dir, `main-${index}.swift`)
      writeFileSync(file, `${nativePrelude(built.program, 'swift', readRuntime)}\n${emitSwift(built.program)}\nprint(compute(), terminator: "")\n`)
      execFileSync('swiftc', [...nativeFlags('swift'), '-o', join(dir, `swift-${index}`), file], { stdio: ['ignore', 'pipe', 'pipe'] })
      out = execFileSync(join(dir, `swift-${index}`)).toString()
    } else {
      const file = join(dir, `main-${index}.kt`)
      const jar = join(dir, `main-${index}.jar`)
      writeFileSync(file, hoistKotlinImports(`${nativePrelude(built.program, 'kotlin', readRuntime)}\n${emitKotlin(built.program)}\nfun main() { print(compute()) }\n`))
      execFileSync('kotlinc', [file, ...nativeFlags('kotlin'), '-include-runtime', '-d', jar], { stdio: ['ignore', 'pipe', 'pipe'] })
      out = execFileSync('java', ['-jar', jar]).toString()
    }

    ok(name, out.trim() === WANT, `got ${out.trim()}, want ${WANT}`)
  } catch (error) {
    const text = String((error as { stderr?: Buffer }).stderr ?? error)
    const lines = text.split('\n')
    const errors = lines.flatMap((line, i) => (/error(\[E\d+\])?:/.test(line) ? lines.slice(i, i + 3) : []))
    ok(name, false, (errors.length ? errors : lines).slice(0, 12).join('\n        '))
  }
}

const TOOLS: Record<string, string[]> = { typescript: [], rust: ['rustc'], swift: ['swiftc'], kotlin: ['kotlinc', 'java'] }

for (const env of ['typescript', 'rust', 'swift', 'kotlin']) {
  if (only && only !== env) {
    continue
  }

  if (TOOLS[env]!.some(tool => !have(tool))) {
    skip++
    console.log(`skip  ${env}  (toolchain not installed)`)
    continue
  }

  CHOICES.forEach(([label, choices], index) => run(env, label, choices, index))
}

// what the pass refuses, rather than guesses at
const refused = (choices: TwinChoices): string =>
  (b => (b.ok ? '' : b.diagnostics.map(d => d.message).join(' | ')))(build('typescript', choices))

ok('a choice of a twin the task does not have is refused', refused({ 'count-each': { use: 'nothing' } }).includes('has none of that name'))
ok('a choice for a task that does not exist is refused', refused({ 'count-none': 'reference' }).includes('no such task'))
ok('a size check on a name that is not a parameter is refused', refused({ 'count-each': { check: 'size', of: 'items', below: 3, then: 'reference', else: { use: 'tally' } } }).includes('not one of its parameters'))

console.log(`\ntwin-select: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
