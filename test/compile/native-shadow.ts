// A Term task named like a host language's own top-level function must not capture the host-language calls the
// toolchain writes. Every file of a native build is one program, so a task `error` taking one value is what a bare
// `error("...")` in a hand-written runtime or in emitted text binds to, and not Kotlin's own, which answers Nothing
// (T-0535, term-self-host-001-0543). This builds, per backend and per arity a host call is written at, one program
// defining every such name, over a closure of runtimes, with the real toolchain, and runs it: a capture is a compile
// error or a wrong answer here. Its static twin, for the runtimes this closure does not reach, is
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

// SHADOW_RUNTIMES reads the runtimes from a mirror of the package tree, to prove an edit before it lands
const readRuntime = (p: string): string | undefined => {
  const mirror = process.env.SHADOW_RUNTIMES
  const drafted = mirror ? p.replace(TERM, mirror) : p
  const from = existsSync(drafted) ? drafted : p

  return existsSync(from) ? readFileSync(from, 'utf8') : undefined
}

// The host names, in the Term spelling that reaches them. Kotlin's default-imported functions; Swift's module-level
// functions; Rust's one prelude function.
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

// Swift ranks a generic exact match above a conversion to Any, so a task taking `unknown` loses to Swift's own `max`,
// and only a task at the host call's own types could capture it. Its own layer of the program, at those types. What
// keeps Swift out of this class is that a task's parameters are labelled (`func max(p0: Int, p1: Int)`) and a host call
// passes none, which the layer holds by the runs it makes.
const TYPED_LAYER = -1
const SWIFT_TYPED: Record<string, string[]> = {
  max: ['number', 'number'],
  min: ['number', 'number'],
  abs: ['number'],
  print: ['text'],
  'fatal-error': ['text'],
  precondition: ['boolean'],
  assert: ['boolean'],
}

const namesAt = (env: Env, arity: number): string[] =>
  arity === TYPED_LAYER ? Object.keys(SWIFT_TYPED) : NAMES[env]

// The stdlib modules whose runtimes the program reaches. Rust's regex, json and random runtimes need crates this
// harness does not add, and they live in their own `mod`, as every Rust runtime does.
const LOADS: Record<Env, string[]> = {
  kotlin: ['uuid', 'time', 'random', 'regex', 'json', 'path', 'cryptography', 'bytes'],
  swift: ['uuid', 'time', 'random', 'regex', 'json', 'path', 'cryptography', 'bytes'],
  rust: ['time', 'path'],
}

// One program defines every name at ONE arity: a name defined twice is an overload, renamed, and captures nothing.
// A shadowing task takes `unknown`, so it fits whatever a host call passes it. Beside the emitter's own host calls (a
// list, a hash, a guard, a raise, a fork as a value) the program reads two runtime calls that compile whether or not
// they are captured: `info` over a host print and `max` over a host maximum, each a wrong answer when captured.
function entry(env: Env, arity: number): string {
  const lines = [
    'load @term/base/text',
    '  find contains',
    '  find substring',
    ...LOADS[env].map(name => `load @term/base/${name}`),
    'load @term/base/log',
    '  find info',
    'load @term/base/math',
    '  find maximum, name biggest',
    'load @term/base/file/blocking',
    '  find read, name read-path',
    '',
  ]

  for (const name of namesAt(env, arity)) {
    lines.push(`task ${name}`)

    if (arity === TYPED_LAYER) {
      SWIFT_TYPED[name]!.forEach((type, at) => {
        lines.push(`  slot p${at}, like ${type}`)
      })
    }

    for (let at = 0; at < arity; at++) {
      lines.push(`  slot p${at}, like unknown`)
    }

    lines.push('  like number', '  send back, code 0', '')
  }

  lines.push(
    'task shadow-probe',
    '  take given, like text',
    '  take kotlin, like number',
    '  like text',
    '  call info',
    '    text <the log reached the host>',
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
    '    send back, <{given} {problem/note} {biggest(kotlin, 5)} {substring(given, 1, 3)}>',
    '',
  )

  return lines.join('\n')
}

function frontEnd(env: Env, arity: number): Program {
  const { sources, scope } = collectModules(
    { file: 'main.tree', text: entry(env, arity) },
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

  const roots = new Set(['shadow-probe', ...namesAt(env, arity)])

  return simplify(program, roots)
}

const stderrOf = (error: unknown): string =>
  String((error as { stderr?: Buffer }).stderr ?? error)

// the arities the host calls of each backend are written at
const ARITIES: Record<Env, number[]> = {
  kotlin: [0, 1, 2, 3],
  swift: [0, 1, 2, TYPED_LAYER],
  rust: [1],
}

// the log line reached the host's print, the guard caught the raise, and the host's maximum answered
const holds = (got: string): boolean =>
  got.includes('the log reached the host') && got.includes('probe caught 5 ro')

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    skip++
    console.log('skip  kotlin (kotlinc/java not installed)')

    return
  }

  for (const arity of ARITIES.kotlin) {
    const label = `kotlin, arity ${arity}`
    const program = frontEnd('kotlin', arity)
    const out = join(dir, `kotlin-${arity}`)
    mkdirSync(out, { recursive: true })
    const file = join(out, 'main.kt')
    const emitted = emitKotlin(program)
    const spell = (name: string): string =>
      name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    const missing = NAMES.kotlin.filter(
      name => !new RegExp(`^fun ${spell(name)}\\(`, 'm').test(emitted),
    )
    ok(`${label}: every name is declared under its own spelling`, missing.length === 0, missing.join(' '))
    writeFileSync(
      file,
      hoistKotlinImports(
        `${nativePrelude(program, 'kotlin', readRuntime)}\n${emitted}\nfun main() { kotlin.io.print(shadowProbe("probe", 1L)) }\n`,
      ),
    )

    try {
      execFileSync(
        'kotlinc',
        [file, '-nowarn', '-include-runtime', '-d', join(out, 'main.jar')],
        { stdio: 'pipe' },
      )
    } catch (error) {
      ok(`${label}: a program defining the names builds`, false, stderrOf(error))

      continue
    }

    ok(`${label}: a program defining ${NAMES.kotlin.length} names builds`, true)
    const got = execFileSync('java', ['-jar', join(out, 'main.jar')]).toString()
    ok(`${label}: the runtime calls and the guard answer`, holds(got), got)
  }
}

function runSwift(): void {
  if (!have('swiftc')) {
    skip++
    console.log('skip  swift (swiftc not installed)')

    return
  }

  for (const arity of ARITIES.swift) {
    const label = `swift, arity ${arity}`
    const program = frontEnd('swift', arity)
    const out = join(dir, `swift-${arity}`)
    mkdirSync(out, { recursive: true })
    const file = join(out, 'main.swift')
    const emitted = emitSwift(program)
    const spell = (name: string): string =>
      name.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase())
    const missing = namesAt('swift', arity).filter(
      name => !new RegExp(`^func ${spell(name)}\\(`, 'm').test(emitted),
    )
    ok(`${label}: every name is declared under its own spelling`, missing.length === 0, missing.join(' '))
    writeFileSync(
      file,
      `${nativePrelude(program, 'swift', readRuntime)}\n${emitted}\nSwift.print(try! shadowProbe(given: "probe", kotlin: 1), terminator: "")\n`,
    )

    try {
      execFileSync('swiftc', ['-o', join(out, 'main'), file], { stdio: 'pipe' })
    } catch (error) {
      ok(`${label}: a program defining the names builds`, false, stderrOf(error))

      continue
    }

    ok(`${label}: a program defining ${namesAt('swift', arity).length} names builds`, true)
    const got = execFileSync(join(out, 'main')).toString()
    ok(`${label}: the runtime calls and the guard answer`, holds(got), got)
  }
}

function runRust(): void {
  if (!have('cargo')) {
    skip++
    console.log('skip  rust (cargo not installed)')

    return
  }

  for (const arity of ARITIES.rust) {
    const label = `rust, arity ${arity}`
    const program = frontEnd('rust', arity)
    const out = join(dir, `rust-${arity}`)
    mkdirSync(join(out, 'src'), { recursive: true })
    const emitted = emitRust(program)
    ok(`${label}: the name is declared`, /^(pub )?fn drop\b/m.test(emitted))
    writeFileSync(
      join(out, 'Cargo.toml'),
      '[package]\nname = "native_shadow"\nversion = "0.0.0"\nedition = "2021"\n',
    )
    writeFileSync(
      join(out, 'src/main.rs'),
      `${nativePrelude(program, 'rust', readRuntime)}\n${emitted}\nfn main() { print!("{}", shadow_probe("probe".to_string(), 1).unwrap_or_else(|e| { eprintln!("{}", e); std::process::exit(1) })); }\n`,
    )

    try {
      const got = execFileSync('cargo', ['run', '--quiet'], {
        cwd: out,
        stdio: ['ignore', 'pipe', 'pipe'],
      }).toString()
      ok(`${label}: a program defining ${NAMES.rust.length} name builds`, true)
      ok(`${label}: the runtime calls and the guard answer`, holds(got), got)
    } catch (error) {
      ok(`${label}: a program defining the names builds`, false, stderrOf(error))
    }
  }
}

// ---- A PROGRAM'S FORM NAMED FOR A WORD OF THE LANGUAGE (decision 110 of term/self-host/change/001-finish-self-host) ----
//
// Rule 3 gives such a form a split name so no emitter's word table reads it as the primitive. Each program goes through
// the real CLI and the real toolchain on all four backends and answers one value. WORDS_ONLY=node|rust|swift|kotlin runs
// one backend, WORDS_SKIP=1 skips this section, and the earlier sections are skipped with WORDS_ALONE=1.
const LINE = join(TERM, 'host/line.js')
const SIZE_FORM = `form size
  case none
  case more
    link prior, like size

task depth
  take n, like number
  like size
  fork test, is-equal(n, 0)
    hold
      back make none
  back make more, bind prior, depth(subtract(n, 1))

task count
  take s, like size
  like number
  sift s
    case none
      back 0
    case more
      link prior
      back add(1, count(prior))
`
const WORD_PROGRAMS: Record<string, { text: string; answer: string }> = {
  size: { text: `${SIZE_FORM}\ntask run\n  back count(depth(3))\n`, answer: '3' },
  number: { text: 'form number\n  link reals, like text\n\ntask one\n  like number\n  back make number, bind reals, <r>\n\ntask run\n  back one()/reals\n', answer: 'r' },
  unit: { text: 'form unit\n  link ring, like text\n\ntask one\n  like unit\n  back make unit, bind ring, <r>\n\ntask run\n  back one()/ring\n', answer: 'r' },
  boolean: { text: 'form boolean\n  link encoding, like text\n\ntask one\n  like boolean\n  back make boolean, bind encoding, <r>\n\ntask run\n  back one()/encoding\n', answer: 'r' },
  text: { text: 'form text\n  link data, like native-string\n\ntask one\n  like text\n  back make text, bind data, <r>\n\ntask run\n  back one()/data\n', answer: 'r' },
  list: { text: 'form list\n  link zone, like native-string\n\ntask one\n  like list\n  back make list, bind zone, <r>\n\ntask run\n  back one()/zone\n', answer: 'r' },
}

const MANIFEST = '\ndeck @term/probe\n  head <check>\n  mark <0.0.2>\n  sort tool\n  lock mit\n'

function wordPackage(name: string, files: Record<string, string>, extra = ''): string {
  const pkg = join(dir, 'words', name)
  mkdirSync(join(pkg, 'code'), { recursive: true })
  writeFileSync(join(pkg, 'deck.tree'), MANIFEST + extra)
  writeFileSync(
    join(pkg, 'role.tree'),
    `role code\n  mark lean\n${Object.keys(files).map(file => `  take @/code/${file}\n`).join('')}`,
  )

  for (const [file, text] of Object.entries(files)) {
    writeFileSync(join(pkg, 'code', file), text)
  }

  return pkg
}

function runLine(pkg: string, args: string[]): { code: number; out: string } {
  try {
    const out = execFileSync('node', ['--max-old-space-size=8192', LINE, ...args], {
      cwd: pkg,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, NO_COLOR: '1', TERM_CACHE_HOME: join(dir, 'words-cache') },
    }).toString()

    return { code: 0, out }
  } catch (error) {
    const failed = error as { status?: number; stdout?: Buffer; stderr?: Buffer }

    return {
      code: failed.status ?? 1,
      out: `${failed.stdout ?? ''}${failed.stderr ?? ''}`,
    }
  }
}

function runWords(): void {
  const wanted = process.env.WORDS_ONLY
  const tools: Record<string, string> = { node: 'node', rust: 'cargo', swift: 'swiftc', kotlin: 'kotlinc' }

  for (const [back, tool] of Object.entries(tools)) {
    if (wanted && wanted !== back) continue

    if (!have(tool)) {
      skip++
      console.log(`skip  words on ${back} (${tool} not installed)`)
      continue
    }

    for (const [name, { text, answer }] of Object.entries(WORD_PROGRAMS)) {
      const pkg = wordPackage(`${name}-${back}`, { 'a.tree': text })
      const ran = runLine(pkg, ['make', 'code/a.tree', '--emit', back, '--run', '--all'])
      const said = ran.out.trim().split('\n').at(-1)?.trim() ?? ''
      ok(`form ${name} on ${back} answers ${answer}`, ran.code === 0 && said === answer, `exit ${ran.code}, said ${said}\n${ran.out}`)
    }
  }

  if (wanted && wanted !== 'node') return

  // ONE PROGRAM HOLDS BOTH MEANINGS: a declares the form, b finds it, c never does and means the number
  const three = wordPackage('three-files', {
    'a.tree': SIZE_FORM,
    'b.tree': 'load ./a\n  find size\n  find depth\n  find count\n\ntask twice\n  take s, like size\n  like number\n  back add(count(s), count(s))\n\ntask start\n  like size\n  back depth(2)\n',
    'c.tree': 'load @term/base/hash\n  find hash\n\nload ./b\n  find twice\n  find start\n\ntask plain\n  take n, like size\n  like size\n  back add(n, twice(start()))\n\ntask holder\n  like hash, like text, like size\n  back make hash\n',
  })

  for (const mode of [['--all', '--merged'], ['--all']]) {
    const made = runLine(three, ['make', ...mode])
    const label = mode.join(' ')
    ok(`three files build (${label})`, made.code === 0, made.out)

    if (made.code !== 0) continue

    // a separate build's own module text is its unit, and host/code re-exports it
    const emitted = (name: string): string =>
      readFileSync(
        join(three, mode.length === 1 ? `host/.unit/_term_probe_code_${name}.ts` : `host/code/${name}.ts`),
        'utf8',
      )
    const b = emitted('b')
    const c = emitted('c')
    ok(`the importer's size is the form (${label})`, /twice\(s: Size/.test(b), b.slice(0, 600))
    ok(`the file that never found it means the number (${label})`, /plain\(n: number\): number/.test(c), c.slice(0, 600))
    ok(`a type argument is the number there too (${label})`, /holder\(\): Map<string, number>/.test(c), c.slice(0, 600))
  }

  // A FILE HOLDING ONLY SUCH A FORM IS A PROGRAM: seed.tree's number.tree, unit.tree and boolean.tree are this shape
  const lone = wordPackage('lone', { 'a.tree': 'form number\n  link reals, like native-string\n' })
  const emitted = runLine(lone, ['make', 'code/a.tree', '--emit', 'node', '--all'])
  ok('a file holding only a form named for a word emits it', emitted.code === 0 && /interface Number/.test(emitted.out), emitted.out)

  // A DOM TEXT IS A TEXT, NOT A STRING: bind's form is real under its native name
  const dom = wordPackage(
    'dom-text',
    { 'a.tree': 'load @term/bind/browser/dom/text\n  find text\n\ntask whole\n  take t, like text\n  like native-string\n  back t/whole-text\n' },
    '  link @term/bind, mark <0.0.x>\n',
  )
  const built = runLine(dom, ['make', '--all', '--merged'])
  ok('a program reading a DOM Text builds', built.code === 0, built.out)
  const domText = existsSync(join(dom, 'host/code/a.ts')) ? readFileSync(join(dom, 'host/code/a.ts'), 'utf8') : ''
  ok('a DOM Text is typed as the form', /whole\(t: Text/.test(domText) && !/whole\(t: string/.test(domText), domText.slice(0, 600))
}

const only = process.env.SHADOW_ONLY

if (!process.env.WORDS_ALONE) {
  if (!only || only === 'kotlin') runKotlin()
  if (!only || only === 'swift') runSwift()
  if (!only || only === 'rust') runRust()
}

if (!process.env.WORDS_SKIP && !only) runWords()

console.log(`native-shadow: ${pass} pass, ${fail} fail, ${skip} skipped`)
process.exit(fail ? 1 : 0)
