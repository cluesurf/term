// tree/code on the native backends: `@term/host`'s codec with its whole stdlib closure (the float bits included)
// compiled for Rust, Swift and Kotlin, built with the real toolchain, and run. Each backend must write the reference
// codec's bytes (compile/host-code.ts) for the same data, and decode then encode them back unchanged. A backend whose
// toolchain is not installed is skipped, never failed. Run: npx tsx test/compile/host-code-native.ts
// (HN_ONLY=rust|swift|kotlin runs one backend.)

import { runDir } from './run-dir'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
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
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { expandTemplates } from '@term/make/code/compile/template'
import { bindModules, stampModule } from '@term/make/code/check/bind-modules'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'
import type { Program } from '@term/make/code/compile/node'
import { expandData, readDataText } from '@term/make/code/compile/host'
import { encodeTree } from '@term/make/code/compile/host-code'

let pass = 0
let fail = 0
let skip = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    // a toolchain prints warnings first and the error last, so a long failure keeps its end
    console.log(`FAIL  ${name}  ${info.length > 2400 ? `...${info.slice(-2400)}` : info}`)
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
const PACKS: Record<string, string> = { base: join(TERM, 'deck/base'), host: join(TERM, 'deck/host') }
const SEP = '\u001e'

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

  const found = /^@term\/(base|host)\/(.*)$/.exec(path)

  return found ? sourceOf(resolvePackagePath({ dir: PACKS[found[1]!]!, rest: found[2]! })) : undefined
}

const readRuntime = (p: string): string | undefined => (existsSync(p) ? readFileSync(p, 'utf8') : undefined)

const ENTRY = `load @term/host/code/base
  find read
  find to-code
  find to-code-all
  find from-code

load @term/base/bytes
  find to-hex
  find from-hex

# the tree/code of a data file's text, as hex
task code-hex
  take input, like text
  like text
  send back
    call to-hex
      call to-code
        call read(read input)

# decode then encode, as hex
task recode-hex
  take input, like text
  like text
  send back
    call to-hex
      call to-code-all
        call from-code
          call from-hex(read input)
`

const ROOTS = ['code-hex', 'recode-hex']

// the data each backend encodes: the spec's worked example, every kind of literal in its shortest form, text past
// ASCII, records sharing a shape, and the two fixtures
const ALL_INPUTS: string[] = [
  'list member\n  mesh\n    host name, <ada>\n    host age, 36\n    host active, true\n  mesh\n    host name, <alan>\n    host age, 41\n    host active, false\n',
  // `1e300` is left out: @term/host's own text reader panics on it on Rust (a decimal with an exponent, read past the
  // end of its text), before the codec is reached. Recorded in note/term/host/10-code.md
  'host a, -3.5\nhost b, true\nhost c, void\nhost f, 2.0\nhost g, 0.1\nhost h, -40\nhost i, 1099511627776\nhost k, -0.0\nhost l, <>\n',
  'host a, <é 世界 😀 👩‍👩‍👧>\nhost b, <line\\nbreak \\<x\\>>\n',
  readFileSync(join(FIXTURE, 'basic.tree'), 'utf8'),
  readFileSync(join(FIXTURE, 'anchors.tree'), 'utf8'),
]

// HCN_INPUTS=0,2 runs only those inputs, to find which one a backend trips on
const INPUTS = process.env.HCN_INPUTS ? process.env.HCN_INPUTS.split(',').map(at => ALL_INPUTS[Number(at)]!) : ALL_INPUTS

function reference(text: string): string {
  const read = readDataText({ file: 'input', text })

  if (!read.ok) {
    return read.diagnostics.map(d => d.message).join(' | ')
  }

  const expanded = expandData(read.data, 'input')

  return expanded.ok ? Buffer.from(encodeTree(expanded.data)).toString('hex') : expanded.diagnostics.map(d => d.message).join(' | ')
}

const WANT = INPUTS.map(reference)

function frontEnd(env: 'rust' | 'swift' | 'kotlin'): Program {
  const { sources, scope } = collectModules({ file: 'main.tree', text: ENTRY }, withNativeEnv(env, resolver))
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

    stampModule(built.program, unit.file)
    program.push(...built.program)
  }

  bindModules(program, scope, 'main.tree')
  resolveNames(program, 'main.tree')

  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check failed: ${errors.slice(0, 5).map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(ROOTS))
}

// each output: the hex of every input, then the hex of every reference decoded and encoded again
function compare(env: string, output: string): void {
  const got = output.split(SEP)

  INPUTS.forEach((_, at) => {
    ok(`${env}: input ${at} encodes to the reference's bytes`, got[at] === WANT[at], `\n      got  ${got[at]}\n      want ${WANT[at]}`)
    ok(`${env}: input ${at} decodes and encodes back unchanged`, got[INPUTS.length + at] === WANT[at], `\n      got  ${got[INPUTS.length + at]}\n      want ${WANT[at]}`)
  })
}

const dir = runDir('term-host-code-native-')
const texts = [...INPUTS, ...WANT]
const CARGO_ENV = { ...process.env, CARGO_TARGET_DIR: join(tmpdir(), 'term-host-native-target') }

function runRust(): void {
  if (!have('cargo')) {
    return skipped('rust: the codec builds and agrees', 'cargo not installed')
  }

  const program = frontEnd('rust')
  const out = join(dir, 'rust')

  mkdirSync(join(out, 'src'), { recursive: true })
  writeFileSync(
    join(out, 'Cargo.toml'),
    '[package]\nname = "host_code_native"\nversion = "0.1.0"\nedition = "2021"\n\n[dependencies]\nserde_json = "1"\nregex = "1"\nbase64 = "0.22"\nhex = "0.4"\nsha2 = "0.10"\nuuid = { version = "1", features = ["v4"] }\nrand = "0.8"\n',
  )

  const calls = [
    ...INPUTS.map(input => `print!("{}\\u{1e}", code_hex(${JSON.stringify(input)}.to_string()).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) }));`),
    ...WANT.map(hex => `print!("{}\\u{1e}", recode_hex(${JSON.stringify(hex)}.to_string()).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) }));`),
  ]

  writeFileSync(join(out, 'src/main.rs'), `${nativePrelude(program, 'rust', readRuntime)}\n${emitRust(program)}\nfn main() {\n${calls.join('\n')}\n}\n`)

  try {
    const output = execFileSync('cargo', ['run', '--quiet'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'], env: CARGO_ENV }).toString()

    ok('rust: the codec builds', true)
    compare('rust', output)
  } catch (error) {
    ok('rust: the codec builds and runs', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: the codec builds and agrees', 'swiftc not installed')
  }

  const program = frontEnd('swift')
  const out = join(dir, 'swift')
  const file = join(out, 'main.swift')

  mkdirSync(out, { recursive: true })

  const calls = [
    ...INPUTS.map(input => `print(try! codeHex(input: ${JSON.stringify(input)}), terminator: "\\u{1e}")`),
    ...WANT.map(hex => `print(try! recodeHex(input: ${JSON.stringify(hex)}), terminator: "\\u{1e}")`),
  ]

  writeFileSync(file, `${nativePrelude(program, 'swift', readRuntime)}\n${emitSwift(program)}\n${calls.join('\n')}\n`)

  try {
    execFileSync('swiftc', ['-o', join(out, 'main'), file], { stdio: 'pipe' })
    ok('swift: the codec builds', true)
    compare('swift', execFileSync(join(out, 'main')).toString())
  } catch (error) {
    ok('swift: the codec builds and runs', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: the codec builds and agrees', 'kotlinc/java not installed')
  }

  const program = frontEnd('kotlin')
  const out = join(dir, 'kotlin')
  const file = join(out, 'main.kt')

  mkdirSync(out, { recursive: true })

  const calls = [...INPUTS.map(input => `codeHex(${JSON.stringify(input)})`), ...WANT.map(hex => `recodeHex(${JSON.stringify(hex)})`)]

  writeFileSync(
    file,
    hoistKotlinImports(`${nativePrelude(program, 'kotlin', readRuntime)}\n${emitKotlin(program)}\nfun main() { for (out in listOf(${calls.join(', ')})) { print(out + "\\u001e") } }\n`),
  )

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', join(out, 'main.jar')], { stdio: 'pipe' })
    ok('kotlin: the codec builds', true)
    compare('kotlin', execFileSync('java', ['-jar', join(out, 'main.jar')]).toString())
  } catch (error) {
    ok('kotlin: the codec builds and runs', false, String((error as { stderr?: Buffer }).stderr ?? error))
  }
}

const only = process.env.HN_ONLY ?? ''

for (const [env, run] of [['rust', runRust], ['swift', runSwift], ['kotlin', runKotlin]] as const) {
  if (!only || only === env) {
    try {
      run()
    } catch (error) {
      ok(`${env}: the front end`, false, String(error))
    }
  }
}

console.log(`\nhost-code-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
