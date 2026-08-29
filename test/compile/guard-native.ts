// A raise is caught on the native backends the way it is on TypeScript (note/term/hive/11-native-exceptions.md):
// a program with a guarded call and an unguarded one, compiled against the real stdlib for each backend, built on
// the real toolchain, and run. The guarded path returns the handler's answer with the exception's fields whole; the
// unguarded raise ends the program with a non-zero exit and the exception's form and note on stderr. GN_ONLY=swift
// (or kotlin, rust) runs one backend. Run: npx tsx test/compile/guard-native.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
import { resolve as resolveNames } from '@term/make/code/check/resolve'
import { check } from '@term/make/code/check/infer'
import { resolveAsync } from '@term/make/code/check/async-resolve'
import { simplify } from '@term/make/code/ir/simplify'
import { collectModules } from '@term/make/code/compile/load'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
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

const HERE = dirname(fileURLToPath(import.meta.url))
const TERM = resolvePath(HERE, '..', '..')
const SEED = join(TERM, 'deck/seed')

// the stdlib, by its import path
const resolver = (path: string): Source | undefined => {
  const rest = path.replace(/^@(?:term|cluesurf)\/seed\//, '')

  if (rest === path) {
    return undefined
  }

  for (const file of [join(SEED, `${rest}.tree`), join(SEED, rest, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

// the error lines of a toolchain's output (its warnings would bury them)
function errorsOf(e: unknown): string {
  const text = String((e as { stderr?: Buffer }).stderr ?? e)
  const errors = text.split('\n').filter(l => /error/.test(l))

  return (errors.length ? errors : text.split('\n')).slice(0, 8).join(' | ').slice(0, 900)
}

const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

// a guarded lookup and an unguarded one, over an exception with a prop of its own
const PROGRAM = `load @term/seed/code/exception
  find absence

form user-absence
  like absence
    bind note, <No such user>
    link key, like text

task find-user
  take key, like text
  like text
  fork test
    hook test
      call is-equal
        read key
        text <a>
    hook hold
      send back, text <alice>
    hook miss
      halt user-absence
        bind thing, text <user>
        bind key, read key

task lookup
  take key, like text
  like text
  note unsafe
    save found
      call find-user
        read key
    send back
      read found
  halt take
    take problem
    send back
      text <caught {{problem/form}}: {{problem/note}}>

task unguarded
  take key, like text
  like text
  send back
    call find-user
      read key

task describe
  take key, like text
  like text
  note unsafe
    send back
      call find-user
        read key
  halt take
    take problem
    fork case, read problem
      case user-absence
        send back, text <no user {{key}}: {{note}}>
`

function frontEnd(env: Env): Program {
  const sources = collectModules({ file: 'main.tree', text: PROGRAM }, withNativeEnv(env, resolver)).sources
  const program: Program = []

  for (const unit of sources) {
    const parsed = parse(unit)

    if (!parsed.ok) {
      throw new Error(`parse failed: ${unit.file}: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
    }

    const built = mill(expandTemplates(parsed.tree), unit.file)

    if (!built.ok) {
      throw new Error(`mill failed: ${unit.file}: ${built.diagnostics.map(d => d.message).join(', ')}`)
    }

    program.push(...built.program)
  }

  extendForms(program, 'main.tree')
  disambiguateOverloads(program)
  resolveNames(program, 'main.tree')
  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 5).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(['lookup', 'unguarded', 'describe']))
}

const dir = mkdtempSync(join(tmpdir(), 'term-guard-native-'))
const only = process.env.GN_ONLY ?? ''

// the answers every backend must give: the happy path, the caught raise with its fields, the uncaught raise
const WANT_FOUND = 'alice'
const WANT_CAUGHT = 'caught user-absence: No such user'
const WANT_CASED = 'no user zed: No such user'

function judge(env: Env, built: { status: number | null; stdout: string; stderr: string }, uncaught: { status: number | null; stderr: string }): void {
  const lines = built.stdout.split('\n')
  ok(`${env}: the happy path returns`, lines[0] === WANT_FOUND, JSON.stringify(lines[0]))
  ok(`${env}: the raise reaches the handler with its form and note`, lines[1] === WANT_CAUGHT, JSON.stringify(lines[1]))
  ok(`${env}: a fork case over the caught value binds the form's prop`, lines[2] === WANT_CASED, JSON.stringify(lines[2]))
  ok(`${env}: an uncaught raise ends the program`, uncaught.status !== 0, `exit ${uncaught.status}`)
  ok(`${env}: the uncaught raise names its form and note`, uncaught.stderr.includes('user-absence') && uncaught.stderr.includes('No such user'), uncaught.stderr.slice(0, 200))
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: guards', 'swiftc not installed')
  }

  const program = frontEnd('swift')
  const source = `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}`
  const main = join(dir, 'main.swift')
  writeFileSync(main, `${source}\nprint(lookup("a"))\nprint(lookup("b"))\nprint(describe("zed"))\nif CommandLine.arguments.count > 1 { print(try! unguarded("z")) }\n`)

  try {
    execFileSync('swiftc', ['-o', join(dir, 'swift-main'), main], { stdio: 'pipe' })
  } catch (e) {
    ok('swift: the guard program builds', false, errorsOf(e))

    return
  }

  ok('swift: the guard program builds', true)
  const built = spawnSync(join(dir, 'swift-main'), [], { encoding: 'utf8' })
  const uncaught = spawnSync(join(dir, 'swift-main'), ['raise'], { encoding: 'utf8' })
  judge('swift', built, uncaught)
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: guards', 'kotlinc/java not installed')
  }

  const program = frontEnd('kotlin')
  const file = join(dir, 'main.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main(args: Array<String>) { println(lookup("a")); println(lookup("b")); println(describe("zed")); if (args.isNotEmpty()) { println(unguarded("z")) } }\n`,
    ),
  )
  const jar = join(dir, 'main.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    ok('kotlin: the guard program builds', false, errorsOf(e))

    return
  }

  ok('kotlin: the guard program builds', true)
  const built = spawnSync('java', ['-jar', jar], { encoding: 'utf8' })
  const uncaught = spawnSync('java', ['-jar', jar, 'raise'], { encoding: 'utf8' })
  judge('kotlin', built, uncaught)
}

// the stdlib's exception module docks crates (uuid for the occurrence code, base64 for its tone shape), so the Rust
// leg builds as a cargo package, sharing the roundtrip's target dir so the crates build once per machine
const CARGO_TOML = `[package]
name = "term-guard-native"
version = "0.1.0"
edition = "2021"

[dependencies]
regex = "1"
sha2 = "0.10"
md-5 = "0.10"
hmac = "0.12"
base64 = "0.22"
hex = "0.4"
uuid = { version = "1", features = ["v4"] }
rand = "0.8"
chrono = "0.4"
serde_json = "1"
unicode-normalization = "0.1"
unicode-segmentation = "1"
`

function runRust(): void {
  if (!have('cargo')) {
    return skipped('rust: guards', 'cargo not installed')
  }

  const program = frontEnd('rust')
  const proj = join(dir, 'rust')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), CARGO_TOML)
  writeFileSync(
    join(proj, 'src', 'main.rs'),
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}\nfn main() { println!("{}", lookup("a".to_string())); println!("{}", lookup("b".to_string())); println!("{}", describe("zed".to_string())); if std::env::args().count() > 1 { match unguarded("z".to_string()) { Ok(v) => println!("{}", v), Err(e) => { eprintln!("{}", e); std::process::exit(1) } } } }\n`,
  )
  const env = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target') }

  try {
    execFileSync('cargo', ['build', '--quiet'], { cwd: proj, stdio: 'pipe', env })
  } catch (e) {
    ok('rust: the guard program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600))

    return
  }

  ok('rust: the guard program builds', true)
  const exe = join(tmpdir(), 'seed-rust-runtime', 'target', 'debug', 'term-guard-native')
  const built = spawnSync(exe, [], { encoding: 'utf8' })
  const uncaught = spawnSync(exe, ['raise'], { encoding: 'utf8' })
  judge('rust', built, uncaught)
}

if (!only || only === 'swift') {
  runSwift()
}

if (!only || only === 'kotlin') {
  runKotlin()
}

if (!only || only === 'rust') {
  runRust()
}

console.log(`\nguard-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
