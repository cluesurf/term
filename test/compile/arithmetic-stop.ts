// An integer overflow is a STOP no guard catches, and a zero divisor is a `defect` a guard catches (D15,
// note/project/term/decisions-2026-10/divisor/spec.md section 2). This file holds the TypeScript half (divisor-0006);
// the Kotlin, Swift and Rust halves join it in divisor-0007 and 0008. Each case is its own process, because a stop ends
// one. Run: npx tsx test/compile/arithmetic-stop.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { parse } from '@term/make/code/parser/tree'
import { stdlibResolver } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'

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

const PROGRAM = `task share
  take total, like number
  take parts, like number
  like text
  fork
    mark unsafe
    save got
      call divide
        read total
        read parts
    send back, text <{got}>
  halt take
    take problem
    send back, text <caught {problem/form}>

task grow
  take a, like number
  take b, like number
  like text
  fork
    mark unsafe
    save got
      call add
        read a
        read b
    send back, text <{got}>
  halt take
    take problem
    send back, text <caught {problem/form}>

task shrink
  take a, like number
  take b, like number
  like text
  fork
    mark unsafe
    save got
      call subtract
        read a
        read b
    send back, text <{got}>
  halt take
    take problem
    send back, text <caught {problem/form}>

task nested
  take a, like number
  take b, like number
  like text
  fork
    mark unsafe
    fork
      mark unsafe
      save got
        call add
          read a
          read b
      send back, text <{got}>
    halt take
      take inner
      send back, text <inner caught {inner/form}>
  halt take
    take problem
    send back, text <outer caught {problem/form}>
`

const built = compile({ file: 'main.tree', text: PROGRAM })

if (!built.ok) {
  console.log(`FAIL  the program compiles  ${JSON.stringify(built.diagnostics?.map(d => d.message) ?? built)}`)
  process.exit(1)
}

const dir = mkdtempSync(join(tmpdir(), 'term-arithmetic-stop-'))
let count = 0

// the emitted module with a tail of calls, run as its own process
function run(tail: string): { status: number | null; stdout: string; stderr: string } {
  const file = join(dir, `case-${count++}.ts`)
  writeFileSync(file, `${built.typescript}\n${tail}\n`)

  return spawnSync('npx', ['tsx', file], { encoding: 'utf8' })
}

const MAX = '9223372036854775807'
const MIN = '-9223372036854775808'

// (a) a zero divisor is a defect, and the guard catches it
const divide = run('console.log(share(6, 3)); console.log(share(6, 0))')
ok('a guarded share(6, 3) answers 2', divide.stdout.split('\n')[0] === '2', JSON.stringify(divide.stdout))
ok('a guarded share(6, 0) prints caught defect', divide.stdout.split('\n')[1] === 'caught defect' && divide.status === 0, JSON.stringify(divide))

// (b) an overflow past the top is a stop: the handler does not run, the process ends non-zero, stderr names excess
const grow = run(`console.log(grow(1, 2)); console.log(grow(${MAX}, 1))`)
ok('a guarded grow(1, 2) answers 3', grow.stdout.split('\n')[0] === '3', JSON.stringify(grow.stdout))
ok('a guarded overflow does not reach the handler', !/caught/.test(grow.stdout), JSON.stringify(grow.stdout))
ok('a guarded overflow ends the process non-zero', grow.status !== 0 && grow.status !== null, String(grow.status))
ok('a guarded overflow names excess on stderr', /excess/.test(grow.stderr), grow.stderr.slice(0, 200))

// (c) the same past the bottom, naming shortage
const shrink = run(`console.log(shrink(${MIN}, 1))`)
ok('a guarded underflow does not reach the handler', !/caught/.test(shrink.stdout), JSON.stringify(shrink.stdout))
ok('a guarded underflow ends the process non-zero', shrink.status !== 0 && shrink.status !== null, String(shrink.status))
ok('a guarded underflow names shortage on stderr', /shortage/.test(shrink.stderr), shrink.stderr.slice(0, 200))

// (d) a guard inside a guard rethrows at each level
const nested = run(`console.log(nested(1, 2)); console.log(nested(${MAX}, 1))`)
ok('a nested guard answers a plain sum', nested.stdout.split('\n')[0] === '3', JSON.stringify(nested.stdout))
ok('neither handler of a nested guard runs on an overflow', !/caught/.test(nested.stdout), JSON.stringify(nested.stdout))
ok('a nested overflow ends the process non-zero naming excess', nested.status !== 0 && nested.status !== null && /excess/.test(nested.stderr), `${nested.status} ${nested.stderr.slice(0, 200)}`)

// the stop is not a Term exception: no TermException class or hive hook is involved
ok('the stop is its own class', /class __TermStop extends Error/.test(built.typescript) && !/__TermStop.*TermException/.test(built.typescript))

// ---- Kotlin (divisor-0007): the same cases on the real toolchain. AS_ONLY=typescript|kotlin runs one backend ----

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

function kotlinFrontEnd(): Program {
  const { sources, scope } = collectModules({ file: 'main.tree', text: KOTLIN_PROGRAM }, withNativeEnv('kotlin', stdlibResolver()!))
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
    }

    const milled = mill(expandTemplates(parsed.tree), unit.file)

    if (!milled.ok) {
      throw new Error(`mill failed: ${unit.file}: ${milled.diagnostics.map(d => d.message).join(', ')}`)
    }

    stampModule(milled.program, unit.file)
    program.push(...milled.program)
  }

  const unbound = bindModules(program, scope, 'main.tree')

  if (unbound.length) {
    throw new Error(`scope failed: ${unbound.slice(0, 5).map(d => d.message).join(' | ')}`)
  }

  resolveNames(program, 'main.tree')
  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 5).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(['share', 'grow', 'shrink', 'nested', 'quotient']))
}

const KOTLIN_PROGRAM = `${PROGRAM}
task quotient
  take a, like number
  take b, like number
  like text
  fork
    mark unsafe
    save got
      call divide
        read a
        read b
    send back, text <{got}>
  halt take
    take problem
    send back, text <caught {problem/form}>
`

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    console.log('skip  kotlin: arithmetic stop  (kotlinc/java not installed)')

    return
  }

  const program = kotlinFrontEnd()
  const kmax = '9223372036854775807L'
  const kmin = '-9223372036854775807L - 1L'
  const main = [
    'fun main(args: Array<String>) {',
    '    when (args[0]) {',
    '        "share" -> { println(share(6L, 3L)); println(share(6L, 0L)) }',
    `        "grow" -> { println(grow(1L, 2L)); println(grow(${kmax}, 1L)) }`,
    `        "shrink" -> { println(shrink(${kmin}, 1L)) }`,
    `        "nested" -> { println(nested(1L, 2L)); println(nested(${kmax}, 1L)) }`,
    `        "quotient" -> { println(quotient(${kmin}, -1L)) }`,
    '    }',
    '}',
  ].join('\n')
  const source = hoistKotlinImports(`${nativePrelude(program, 'kotlin', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))}\n${emitKotlin(program)}\n${main}\n`)
  const file = join(dir, 'main.kt')
  const jar = join(dir, 'main.jar')
  writeFileSync(file, source)

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    ok('kotlin: the program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).split('\n').filter(l => /error/.test(l)).slice(0, 8).join(' | '))

    return
  }

  ok('kotlin: the program builds', true)
  const kotlinRun = (which: string) => spawnSync('java', ['-jar', jar, which], { encoding: 'utf8' })

  // (a) a zero divisor is a defect, and the guard catches it
  const kShare = kotlinRun('share')
  ok('kotlin: a guarded share(6, 3) answers 2', kShare.stdout.split('\n')[0] === '2', JSON.stringify(kShare.stdout))
  ok('kotlin: a guarded share(6, 0) prints caught defect', kShare.stdout.split('\n')[1] === 'caught defect' && kShare.status === 0, JSON.stringify(kShare))

  // (b) an overflow past the top is a stop
  const kGrow = kotlinRun('grow')
  ok('kotlin: a guarded grow(1, 2) answers 3', kGrow.stdout.split('\n')[0] === '3', JSON.stringify(kGrow.stdout))
  ok('kotlin: a guarded overflow does not reach the handler', !/caught/.test(kGrow.stdout), JSON.stringify(kGrow.stdout))
  ok('kotlin: a guarded overflow ends the process non-zero', kGrow.status !== 0 && kGrow.status !== null, String(kGrow.status))
  ok('kotlin: a guarded overflow names excess on stderr', /excess/.test(kGrow.stderr), kGrow.stderr.slice(0, 200))

  // (c) past the bottom, naming shortage
  const kShrink = kotlinRun('shrink')
  ok('kotlin: a guarded underflow does not reach the handler', !/caught/.test(kShrink.stdout), JSON.stringify(kShrink.stdout))
  ok('kotlin: a guarded underflow ends the process non-zero', kShrink.status !== 0 && kShrink.status !== null, String(kShrink.status))
  ok('kotlin: a guarded underflow names shortage on stderr', /shortage/.test(kShrink.stderr), kShrink.stderr.slice(0, 200))

  // (d) a guard inside a guard rethrows at each level
  const kNested = kotlinRun('nested')
  ok('kotlin: a nested guard answers a plain sum', kNested.stdout.split('\n')[0] === '3', JSON.stringify(kNested.stdout))
  ok('kotlin: neither handler of a nested guard runs on an overflow', !/caught/.test(kNested.stdout), JSON.stringify(kNested.stdout))
  ok('kotlin: a nested overflow ends the process non-zero naming excess', kNested.status !== 0 && kNested.status !== null && /excess/.test(kNested.stderr), `${kNested.status} ${kNested.stderr.slice(0, 200)}`)

  // (e) min / -1 is an overflow, not a defect
  const kQuotient = kotlinRun('quotient')
  ok('kotlin: a guarded divide(min, -1) does not reach the handler', !/caught/.test(kQuotient.stdout), JSON.stringify(kQuotient.stdout))
  ok('kotlin: a guarded divide(min, -1) ends the process non-zero naming excess', kQuotient.status !== 0 && kQuotient.status !== null && /excess/.test(kQuotient.stderr), `${kQuotient.status} ${kQuotient.stderr.slice(0, 200)}`)

  ok('kotlin: the stop is its own class, not a TermException', /class TermStop\(message: String\) : Error\(message\)/.test(source))
}

if (!process.env.AS_ONLY || process.env.AS_ONLY === 'kotlin') {
  runKotlin()
}

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
