// A Term task named like a host language's own top-level function must not capture the host-language calls the
// toolchain writes. Every file of a native build is one program, so a task `error` taking one value is what a bare
// `error("...")` in a hand-written runtime or in emitted text binds to, and not Kotlin's own, which answers Nothing
// (T-0535, term-self-host-001-0543). This builds one program per backend that defines every such name at every arity a
// runtime calls it with, over a closure of runtimes, with the real toolchain, and runs it: a capture is a compile error
// or a wrong answer here. Its static twin, for the runtimes this closure does not reach, is
// deck/make/test/kotlin-bare-error.tree. A backend whose toolchain is absent is skipped, never failed.
// Run: npx tsx test/compile/native-shadow.ts (SHADOW_ONLY=rust|swift|kotlin runs one backend.)

import { runDir } from './run-dir'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from '@term/make/code/parser/tree'
import { resolvePackagePath, sourceOf } from '@term/make/code/resolve'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import {
  withNativeEnv,
  nativePrelude,
} from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import {
  bindModules,
  stampModule,
} from '@term/make/code/check/bind-modules'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import {
  emitKotlin,
  hoistKotlinImports,
} from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'

type Env = 'rust' | 'swift' | 'kotlin'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}\n${info.slice(0, Number(process.env.SHADOW_INFO ?? 3000))}`)
  }
}

function have(tool: string): boolean {
  try {
    execFileSync('which', [tool], { stdio: 'ignore' })

    return true
  } catch {
    return false
  }
}

const HERE =
  import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const dir = process.env.SHADOW_DIR ?? runDir('native-shadow')

const resolver = (path: string, from: string): Source | undefined => {
  if (path.startsWith('./') || path.startsWith('../')) {
    const base = join(from.replace(/\/[^/]*$/, ''), path)

    for (const file of [`${base}.tree`, join(base, 'base.tree')]) {
      if (existsSync(file)) {
        return { file, text: readFileSync(file, 'utf8') }
      }
    }

    return undefined
  }

  const found = /^@term\/base\/(.*)$/.exec(path)

  if (!found) {
    return undefined
  }

  return sourceOf(
    resolvePackagePath({ dir: join(TERM, 'deck/base'), rest: found[1]! }),
  )
}

const readRuntime = (p: string): string | undefined =>
  existsSync(p) ? readFileSync(p, 'utf8') : undefined

// The host names, in the Term spelling that reaches them. Kotlin's default-imported functions; Swift's module-level
// functions (a task's `slot` is positional there, as those calls are); Rust's one prelude function.
const NAMES: Record<Env, string[]> = {
  kotlin: [
    'error', 'print', 'println', 'check', 'check-not-null', 'require', 'require-not-null', 'assert',
    'run', 'with', 'repeat', 'lazy', 'synchronized', 'run-catching', 'read-line', 'readln',
    'list-of', 'mutable-list-of', 'array-list-of', 'empty-list', 'map-of', 'mutable-map-of', 'hash-map-of',
    'linked-map-of', 'empty-map', 'set-of', 'mutable-set-of', 'hash-set-of', 'linked-set-of', 'empty-set',
    'array-of', 'array-of-nulls', 'int-array-of', 'long-array-of', 'double-array-of', 'byte-array-of',
    'empty-array', 'max-of', 'min-of', 'compare-by', 'sequence-of', 'generate-sequence', 'build-string', 'build-list',
  ],
  swift: [
    'print', 'fatal-error', 'precondition', 'precondition-failure', 'assert', 'assertion-failure',
    'min', 'max', 'abs', 'zip', 'stride', 'swap', 'dump', 'repeat-element', 'sequence',
    'with-unsafe-bytes', 'with-unsafe-mutable-bytes', 'with-extended-lifetime', 'readLine', 'unsafe-bit-cast',
    'numeric-cast',
  ],
  rust: ['drop'],
}

// A method-free program that reaches the emitter's own host calls: a list, a hash, a guard, a raise, a fork as a value.
function entry(env: Env): string {
  const lines = [
    'load @term/base/text',
    '  find contains',
    'load @term/base/uuid',
    'load @term/base/time',
    'load @term/base/random',
    'load @term/base/regex',
    'load @term/base/json',
    'load @term/base/path',
    'load @term/base/math',
    'load @term/base/log',
    'load @term/base/console',
    'load @term/base/cryptography',
    'load @term/base/bytes',
    'load @term/base/file/blocking',
    '  find read, name read-path',
    '',
  ]

  for (const name of NAMES[env]) {
    for (const arity of [0, 1, 2, 3]) {
      lines.push(`task ${name}`)

      for (let at = 0; at < arity; at++) {
        lines.push(`  slot p${at}, like unknown`)
      }

      lines.push('  like number', '  send back, code 0', '')
    }
  }

  lines.push(
    'task shadow-probe',
    '  take given, like text',
    '  like text',
    '  save items, make list',
    '  items/push(given)',
    '  save table, make hash',
    '  table/set(given, 1)',
    '  fork test, contains(given, <never>)',
    '    hold',
    '      halt <a raise>',
    '  fork',
    '    mark unsafe',
    '    fork test, is-equal(items/length, 1)',
    '      hold',
    '        halt <caught>',
    '    send back, <not raised>',
    '  halt take',
    '    take problem',
    '    send back, <{given} {problem/note}>',
    '',
  )

  return lines.join('\n')
}

function frontEnd(env: Env): Program {
  const { sources, scope } = collectModules(
    { file: 'main.tree', text: entry(env) },
    withNativeEnv(env, resolver),
  )
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(
        `parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(
        `mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`,
      )
    }

    stampModule(built.program, unit.file)
    program.push(...built.program)
  }

  bindModules(program, scope, 'main.tree')
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(
    d => d.severity !== 'warning',
  )

  if (errors.length) {
    throw new Error(
      `check failed: ${errors
        .slice(0, 8)
        .map(d => d.message)
        .join(' | ')}`,
    )
  }

  resolveAsync(program)

  const roots = new Set(['shadow-probe', ...NAMES[env]])

  return simplify(program, roots)
}

const stderrOf = (error: unknown): string =>
  String((error as { stderr?: Buffer }).stderr ?? error)

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    skip++
    console.log('skip  kotlin (kotlinc/java not installed)')

    return
  }

  const program = frontEnd('kotlin')
  const out = join(dir, 'kotlin')
  mkdirSync(out, { recursive: true })
  const file = join(out, 'main.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { kotlin.io.print(shadowProbe("probe")) }\n`,
    ),
  )

  try {
    execFileSync(
      'kotlinc',
      [file, '-nowarn', '-include-runtime', '-d', join(out, 'main.jar')],
      { stdio: 'pipe' },
    )
  } catch (error) {
    ok('kotlin: a program defining the names builds', false, stderrOf(error))

    return
  }

  ok(`kotlin: a program defining ${NAMES.kotlin.length} names builds`, true)
  const got = execFileSync('java', ['-jar', join(out, 'main.jar')]).toString()
  ok('kotlin: it runs and the guard catches the raise', got === 'probe caught', got)
}

function runSwift(): void {
  if (!have('swiftc')) {
    skip++
    console.log('skip  swift (swiftc not installed)')

    return
  }

  const program = frontEnd('swift')
  const out = join(dir, 'swift')
  mkdirSync(out, { recursive: true })
  const file = join(out, 'main.swift')
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\nSwift.print(try! shadowProbe(given: "probe"), terminator: "")\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(out, 'main'), file], { stdio: 'pipe' })
  } catch (error) {
    ok('swift: a program defining the names builds', false, stderrOf(error))

    return
  }

  ok(`swift: a program defining ${NAMES.swift.length} names builds`, true)
  const got = execFileSync(join(out, 'main')).toString()
  ok('swift: it runs and the guard catches the raise', got === 'probe caught', got)
}

function runRust(): void {
  if (!have('cargo')) {
    skip++
    console.log('skip  rust (cargo not installed)')

    return
  }

  const program = frontEnd('rust')
  const out = join(dir, 'rust')
  mkdirSync(join(out, 'src'), { recursive: true })
  writeFileSync(
    join(out, 'Cargo.toml'),
    '[package]\nname = "native_shadow"\nversion = "0.0.0"\nedition = "2021"\n',
  )
  writeFileSync(
    join(out, 'src/main.rs'),
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}\nfn main() { print!("{}", shadow_probe("probe".to_string()).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })); }\n`,
  )

  try {
    const got = execFileSync('cargo', ['run', '--quiet'], {
      cwd: out,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString()
    ok(`rust: a program defining ${NAMES.rust.length} name builds`, true)
    ok('rust: it runs and the guard catches the raise', got === 'probe caught', got)
  } catch (error) {
    ok('rust: a program defining the names builds', false, stderrOf(error))
  }
}

const only = process.env.SHADOW_ONLY

if (!only || only === 'kotlin') runKotlin()
if (!only || only === 'swift') runSwift()
if (!only || only === 'rust') runRust()

console.log(`native-shadow: ${pass} pass, ${fail} fail, ${skip} skipped`)
process.exit(fail ? 1 : 0)
