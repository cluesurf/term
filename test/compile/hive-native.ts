// The hive told natively (native-exceptions-0006): the compiler emits `wake_hive` / `wakeHive` per backend from
// the roll, the entry point calls it, and every native raise tells the hive before unwinding — the same funnel
// the TypeScript constructor hook carries. A program wakes its hive (one static exception entry), raises, catches,
// and reads `hive-roll`: one deck woken, the static entry present, and the raise appended with its form as the
// entry name. Built and run on the real toolchains. HV_ONLY=rust (or swift, kotlin) runs one backend.
// Run: npx tsx test/compile/hive-native.ts

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
import type { WakeGroup } from '@term/make/code/compile/rust'
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

const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

// the exception raised, and a probe that reads the hive after a caught raise: decks woken, exception entries,
// and the last entry's name (the raise the tell appended)
const PROGRAM = `load @term/seed/code/exception
  find absence

load @term/seed/code/hive
  find hive-roll
  find hive-size
  find hive-entry

load @term/seed/code/list
  find size
  find get

form user-absence
  like absence
    bind note, <No such user>
    link key, like text

task find-user
  take key, like text
  like text
  halt user-absence
    bind thing, text <user>
    bind key, read key

task check-hive
  like text
  save before
    call size
      call hive-roll
        text <exception>
  note unsafe
    save found
      call find-user
        text <zed>
    send back, read found
  halt take
    take problem
    save decks
      call hive-size
    save entries
      call hive-roll
        text <exception>
    save after
      call size
        read entries
    save last
      call get
        read entries
        call subtract
          read after
          code 1
    send back
      text <decks={{decks}} before={{before}} after={{after}} last={{last/name}}>

task hive-size-of
  like number
  send back
    call hive-size
`

// what the roll would carry for this build: one deck, its one exception declaration
const WAKE: WakeGroup[] = [
  {
    deck: '@probe/hive',
    entries: [
      { host: '@probe/hive', kind: 'exception', name: 'user-absence', site: 'main.tree', base: { like: 'absence' } },
    ],
  },
]

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

  // the hive's entry points ride along the way compile.ts keeps them: the wake chain calls them
  return simplify(program, new Set(['check-hive', 'hive-size-of', 'hive-wake', 'hive-tell', 'hive-roll']))
}

const dir = mkdtempSync(join(tmpdir(), 'term-hive-native-'))
const only = process.env.HV_ONLY ?? ''

// one deck woken; the static entry before the raise; the raise appended with the exception's form as its name
const WANT = 'decks=1 before=1 after=2 last=user-absence'

function judge(env: Env, run: { status: number | null; stdout: string; stderr: string }): void {
  ok(
    `${env}: the wake chain fills the roll and a native raise tells the hive`,
    run.status === 0 && run.stdout.trim() === WANT,
    `exit ${run.status}: ${(run.stdout + run.stderr).slice(0, 300)}`,
  )
}

const CARGO_TOML = `[package]
name = "term-hive-native"
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
    return skipped('rust: hive', 'cargo not installed')
  }

  const program = frontEnd('rust')
  const proj = join(dir, 'rust')
  mkdirSync(join(proj, 'src'), { recursive: true })
  writeFileSync(join(proj, 'Cargo.toml'), CARGO_TOML)
  writeFileSync(
    join(proj, 'src', 'main.rs'),
    `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program, { wake: WAKE })}\nfn main() { wake_hive(); println!("{}", check_hive()); }\n`,
  )
  const env = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'seed-rust-runtime', 'target') }

  try {
    execFileSync('cargo', ['build', '--quiet'], { cwd: proj, stdio: 'pipe', env })
  } catch (e) {
    ok('rust: the hive program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600))

    return
  }

  ok('rust: the hive program builds', true)
  judge('rust', spawnSync(join(tmpdir(), 'seed-rust-runtime', 'target', 'debug', 'term-hive-native'), [], { encoding: 'utf8' }))
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: hive', 'swiftc not installed')
  }

  const program = frontEnd('swift')
  const main = join(dir, 'main.swift')
  writeFileSync(
    main,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program, { wake: WAKE })}\nwakeHive()\nprint(checkHive())\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(dir, 'swift-main'), main], { stdio: 'pipe' })
  } catch (e) {
    ok('swift: the hive program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600))

    return
  }

  ok('swift: the hive program builds', true)
  judge('swift', spawnSync(join(dir, 'swift-main'), [], { encoding: 'utf8' }))
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: hive', 'kotlinc/java not installed')
  }

  const program = frontEnd('kotlin')
  const file = join(dir, 'main.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program, { wake: WAKE })}\nfun main() { wakeHive(); println(checkHive()) }\n`,
    ),
  )
  const jar = join(dir, 'main.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    ok('kotlin: the hive program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 600))

    return
  }

  ok('kotlin: the hive program builds', true)
  judge('kotlin', spawnSync('java', ['-jar', jar], { encoding: 'utf8' }))
}

if (!only || only === 'rust') {
  runRust()
}

if (!only || only === 'swift') {
  runSwift()
}

if (!only || only === 'kotlin') {
  runKotlin()
}

console.log(`\nhive-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
