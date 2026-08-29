// The @term/host package on the native backends: the package entry plus its whole stdlib closure, compiled for
// Rust, Swift and Kotlin, built with the real toolchain, and run on the fixtures. Each backend must give the long
// form of the basic and anchors fixtures byte for byte, from the long and the compact spelling. A backend whose
// toolchain is not installed is skipped, never failed. Run: npx tsx test/compile/host-native.ts
// (HN_ONLY=rust|swift|kotlin runs one backend.)

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import { expandData, readDataText, writeLong } from '@term/make/code/compile/host'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info.slice(0, 600)}`)
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

const HERE = import.meta.dirname ?? new URL('.', import.meta.url).pathname
const TERM = join(HERE, '../..')
const FIXTURE = join(TERM, 'deck/host/test/fixture')
const PACKS: Record<string, string> = { seed: join(TERM, 'deck/seed'), host: join(TERM, 'deck/host') }
const fixture = (name: string): string => readFileSync(join(FIXTURE, name), 'utf8')

// the record separator between one program's outputs
const SEP = ''

// the stdlib and the package by name, and relative loads from the file that makes them
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

  const found = /^@(?:cluesurf|term)\/(seed|host)\/(.*)$/.exec(path)

  if (!found) {
    return undefined
  }

  for (const file of [join(PACKS[found[1]!]!, `${found[2]}.tree`), join(PACKS[found[1]!]!, found[2]!, 'base.tree')]) {
    if (existsSync(file)) {
      return { file, text: readFileSync(file, 'utf8') }
    }
  }

  return undefined
}

const readRuntime = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)

const ENTRY = `load @term/host/code/base
  find read
  find write

task round-long
  take input, like text
  like text
  send back
    call write(call read(read input))
`

// a form filled from data and melted back, with a nested form, a list, an optional field and a decimal
const FILL_ENTRY = `load @term/host/code/base
  find data
  find read
  find write

form limit
  link burst, like number
  link rate, like decimal

form service
  link name, like text
  link retry-after, like number
  link secure, like boolean
  link region, like text
    need false
  link limit, like limit
  link tags
    like list
      like text

task fill-round
  take input, like text
  like text
  save loaded
    call fill
      call read(read input)
      like service
  send back
    call write
      call melt
        read loaded
        like service

task fill-burst
  take input, like text
  like number
  save loaded
    call fill
      call read(read input)
      like service
  send back, read loaded/limit/burst
`

const FILL_GOOD = 'host name, <api>\nhost retry-after, 3\nhost secure, true\nhost limit\n  host burst, 10\n  host rate, 2.5\nlist tags\n  <a>, <b>\n'
// the melt writes fields in the form's declared order, so `region` comes back before `limit`
const FILL_REGION = FILL_GOOD + 'host region, <eu>\n'
const FILL_REGION_BACK = FILL_GOOD.replace('host limit\n', 'host region, <eu>\nhost limit\n')

type Env = 'rust' | 'swift' | 'kotlin'

// the package and its closure, front-ended for one backend
function frontEnd(env: Env, entry = ENTRY, roots = ['round-long']): Program {
  const sources = collectModules({ file: 'main.tree', text: entry }, withNativeEnv(env, resolver)).sources
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

  return simplify(program, new Set(roots))
}

// each case: a name, the input text, and the long form it must give back (the compiler's writer is the oracle for
// an input that is not a fixture, so HN_INPUT=<text> tries one input on the backends)
const CASES: [string, string, string][] = process.env.HN_INPUTS
  ? (JSON.parse(process.env.HN_INPUTS) as string[]).map((input, at) => [`input ${at}`, input, oracle(input)])
  : process.env.HN_INPUT
  ? [['input', process.env.HN_INPUT, oracle(process.env.HN_INPUT)]]
  : [
      ['basic long', fixture('basic.tree'), fixture('basic.tree')],
      ['basic compact', fixture('basic.line'), fixture('basic.tree')],
      // `read` expands the anchors, so the long form back is the expanded one the compiler's writer gives
      ['anchors long', fixture('anchors.tree'), oracle(fixture('anchors.tree'))],
      ['anchors compact', fixture('anchors.line'), oracle(fixture('anchors.tree'))],
    ]

function oracle(text: string): string {
  const read = readDataText({ file: 'input', text })

  if (!read.ok) {
    return read.diagnostics.map(d => d.message).join(' | ')
  }

  const expanded = expandData(read.data, 'input')

  return expanded.ok ? writeLong(expanded.data) : expanded.diagnostics.map(d => d.message).join(' | ')
}

const dir = mkdtempSync(join(tmpdir(), 'term-host-native-'))
const inputs = CASES.map(([, input]) => JSON.stringify(input))

function compare(env: string, output: string): void {
  const got = output.split(SEP)
  CASES.forEach(([name, , want], at) =>
    ok(`${env}: ${name} round-trips`, got[at] === want, `got ${JSON.stringify(got[at] ?? '')}\n      want ${JSON.stringify(want)}`),
  )
}

function runRust(): void {
  if (!have('cargo')) {
    return skipped('rust: the package builds and round-trips', 'cargo not installed')
  }

  const program = frontEnd('rust')
  const out = join(dir, 'rust')
  mkdirSync(join(out, 'src'), { recursive: true })
  writeFileSync(
    join(out, 'Cargo.toml'),
    '[package]\nname = "host_native"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\nregex = "1"\nbase64 = "0.22"\nhex = "0.4"\nsha2 = "0.10"\nuuid = { version = "1", features = ["v4"] }\nrand = "0.8"\n',
  )
  const main = `\nfn main() {\n  let inputs: Vec<&str> = vec![${inputs.join(', ')}];\n  for input in inputs { print!("{}\\u{1e}", round_long(input.to_string())); }\n}\n`
  writeFileSync(join(out, 'src/main.rs'), `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}${main}`)

  let output: string

  try {
    output = execFileSync('cargo', ['run', '--quiet'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'] }).toString()
  } catch (error) {
    ok('rust: the package builds', false, String((error as { stderr?: Buffer }).stderr ?? error))

    return
  }

  ok('rust: the package builds', true)
  compare('rust', output)

  // fill and melt with a form
  const fill = frontEnd('rust', FILL_ENTRY, ['fill-round', 'fill-burst'])
  const fillOut = join(dir, 'rust-fill')
  mkdirSync(join(fillOut, 'src'), { recursive: true })
  writeFileSync(join(fillOut, 'Cargo.toml'), readFileSync(join(out, 'Cargo.toml'), 'utf8').replace('host_native', 'host_fill'))
  writeFileSync(
    join(fillOut, 'src/main.rs'),
    `${nativePrelude(fill, 'rust', readRuntime)}\n${emitRust(fill)}\nfn main() { print!("{}\\u{1e}{}\\u{1e}{}", fill_round(${JSON.stringify(FILL_GOOD)}.to_string()), fill_round(${JSON.stringify(FILL_REGION)}.to_string()), fill_burst(${JSON.stringify(FILL_GOOD)}.to_string())); }\n`,
  )

  try {
    const got = execFileSync('cargo', ['run', '--quiet'], { cwd: fillOut, stdio: ['ignore', 'pipe', 'pipe'] }).toString().split(SEP)
    ok('rust: fill and melt with a form build', true)
    ok('rust: fill into a form melts back to the data', got[0] === FILL_GOOD, got[0] ?? '')
    ok('rust: an optional field present is kept', got[1] === FILL_REGION_BACK, got[1] ?? '')
    ok('rust: a nested form is filled', got[2] === '10', got[2] ?? '')
  } catch (error) {
    ok('rust: fill and melt with a form build', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: the package builds and round-trips', 'swiftc not installed')
  }

  const program = frontEnd('swift')
  const out = join(dir, 'swift')
  mkdirSync(out, { recursive: true })
  const file = join(out, 'main.swift')
  writeFileSync(
    file,
    `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\nfor input in [${inputs.join(', ')}] { print(roundLong(input), terminator: "\\u{1e}") }\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(out, 'main'), file], { stdio: 'pipe' })
  } catch (error) {
    ok('swift: the package builds', false, String((error as { stderr?: Buffer }).stderr ?? error))

    return
  }

  ok('swift: the package builds', true)
  compare('swift', execFileSync(join(out, 'main')).toString())

  // fill and melt with a form
  const fill = frontEnd('swift', FILL_ENTRY, ['fill-round', 'fill-burst'])
  const fillFile = join(out, 'fill.swift')
  writeFileSync(
    fillFile,
    `${nativePrelude(fill, 'swift', readRuntime)}\n${emitSwift(fill)}\nprint(fillRound(${JSON.stringify(FILL_GOOD)}), terminator: "\\u{1e}")\nprint(fillRound(${JSON.stringify(FILL_REGION)}), terminator: "\\u{1e}")\nprint(fillBurst(${JSON.stringify(FILL_GOOD)}), terminator: "")\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(out, 'fill'), fillFile], { stdio: 'pipe' })
    const got = execFileSync(join(out, 'fill')).toString().split(SEP)
    ok('swift: fill and melt with a form build', true)
    ok('swift: fill into a form melts back to the data', got[0] === FILL_GOOD, got[0] ?? '')
    ok('swift: an optional field present is kept', got[1] === FILL_REGION_BACK, got[1] ?? '')
    ok('swift: a nested form is filled', got[2] === '10', got[2] ?? '')
  } catch (error) {
    ok('swift: fill and melt with a form build', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

// org.json is not in the JDK: the shim's parser. A cached jar runs the program; without one the build is checked
// and the run is skipped
function jsonJar(): string | undefined {
  const cached = join(tmpdir(), 'term-json-20240303.jar')

  if (existsSync(cached)) {
    return cached
  }

  try {
    execFileSync(
      'curl',
      ['-sL', '--max-time', '30', '-o', cached, 'https://repo1.maven.org/maven2/org/json/json/20240303/json-20240303.jar'],
      { stdio: 'ignore' },
    )

    return existsSync(cached) ? cached : undefined
  } catch {
    return undefined
  }
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: the package builds and round-trips', 'kotlinc/java not installed')
  }

  const program = frontEnd('kotlin')
  const out = join(dir, 'kotlin')
  mkdirSync(out, { recursive: true })
  const file = join(out, 'main.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { for (input in listOf(${inputs.join(', ')})) { print(roundLong(input) + "\\u001e") } }\n`,
    ),
  )
  const jar = jsonJar()

  try {
    execFileSync('kotlinc', [file, ...(jar ? ['-cp', jar] : []), '-include-runtime', '-d', join(out, 'main.jar')], {
      stdio: 'pipe',
    })
  } catch (error) {
    ok('kotlin: the package builds', false, String((error as { stderr?: Buffer }).stderr ?? error))

    return
  }

  ok('kotlin: the package builds', true)

  if (!jar) {
    return skipped('kotlin: round-trips', 'org.json is not available to run the shim')
  }

  compare('kotlin', execFileSync('java', ['-cp', `${join(out, 'main.jar')}:${jar}`, 'MainKt']).toString())

  // fill and melt with a form
  const fill = frontEnd('kotlin', FILL_ENTRY, ['fill-round', 'fill-burst'])
  const fillFile = join(out, 'fill.kt')
  writeFileSync(
    fillFile,
    hoistKotlinImports(
      `${nativePrelude(fill, 'kotlin', readRuntime)}\n${emitKotlin(fill)}\nfun main() { print(fillRound(${JSON.stringify(FILL_GOOD)}) + "\\u001e" + fillRound(${JSON.stringify(FILL_REGION)}) + "\\u001e" + fillBurst(${JSON.stringify(FILL_GOOD)})) }\n`,
    ),
  )

  try {
    execFileSync('kotlinc', [fillFile, '-cp', jar, '-include-runtime', '-d', join(out, 'fill.jar')], { stdio: 'pipe' })
    const got = execFileSync('java', ['-cp', `${join(out, 'fill.jar')}:${jar}`, 'FillKt']).toString().split(SEP)
    ok('kotlin: fill and melt with a form build', true)
    ok('kotlin: fill into a form melts back to the data', got[0] === FILL_GOOD, got[0] ?? '')
    ok('kotlin: an optional field present is kept', got[1] === FILL_REGION_BACK, got[1] ?? '')
    ok('kotlin: a nested form is filled', got[2] === '10', got[2] ?? '')
  } catch (error) {
    ok('kotlin: fill and melt with a form build', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

const only = process.env.HN_ONLY ?? ''

if (!only || only === 'rust') {
  runRust()
}

if (!only || only === 'swift') {
  runSwift()
}

if (!only || only === 'kotlin') {
  runKotlin()
}

console.log(`\nhost-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
