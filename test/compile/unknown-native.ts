// `unknown` on the native backends (native-exceptions-0010): a `like unknown` slot lowers to the boxed dynamic
// (Rust `std::rc::Rc<dyn std::any::Any>`, Swift and Kotlin `Any`), never to a number, so a form like `hive-entry`
// can carry a record in its `base`. A program stores a record in an unknown field, passes it through an unknown
// parameter and result, and downcasts it back natively; each backend builds on its real toolchain and runs.
// UN_ONLY=rust (or swift, kotlin) runs one backend. Run: npx tsx test/compile/unknown-native.ts

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

// a record stored in an unknown field, passed through an unknown parameter and an unknown result
const PROGRAM = `form user
  link name, like text

form entry
  link tag, like text
  link base, like unknown

task hold-user
  take name, like text
  like entry
  send back
    make entry
      bind tag, text <user>
      bind base
        make user
          bind name, read name

task carry
  take value, like unknown
  like unknown
  send back, read value
`

function frontEnd(): Program {
  const parsed = parse({ file: 'main.tree', text: PROGRAM })

  if (!parsed.ok) {
    throw new Error(`parse: ${parsed.diagnostics.map(d => d.message).join(', ')}`)
  }

  const built = mill(expandTemplates(parsed.tree), 'main.tree')

  if (!built.ok) {
    throw new Error(`mill: ${built.diagnostics.map(d => d.message).join(', ')}`)
  }

  const program = built.program
  extendForms(program, 'main.tree')
  disambiguateOverloads(program)
  resolveNames(program, 'main.tree')
  const errors = check(program, 'main.tree').filter(d => d.severity !== 'warning')

  if (errors.length) {
    throw new Error(`check: ${errors.map(d => d.message).join(' | ')}`)
  }

  resolveAsync(program)

  return simplify(program, new Set(['hold-user', 'carry']))
}

const dir = mkdtempSync(join(tmpdir(), 'term-unknown-native-'))
const only = process.env.UN_ONLY ?? ''
const WANT = 'user alice'

function judge(env: Env, run: { status: number | null; stdout: string; stderr: string }): void {
  ok(
    `${env}: a record rides in the unknown slot and downcasts back`,
    run.status === 0 && run.stdout.trim() === WANT,
    `exit ${run.status}: ${(run.stdout + run.stderr).slice(0, 200)}`,
  )
}

function runRust(): void {
  if (!have('rustc')) {
    return skipped('rust: unknown', 'rustc not installed')
  }

  const source = emitRust(frontEnd())
  ok(
    'rust: unknown lowers to Rc<dyn Any>',
    source.includes('std::rc::Rc<dyn std::any::Any>'),
    source.slice(0, 200),
  )
  const main = join(dir, 'main.rs')
  writeFileSync(
    main,
    `#![allow(dead_code, unused_mut)]\n${source}\nfn main() { let e = hold_user("alice".to_string()); let kept = carry(e.base.clone()); let user = kept.downcast_ref::<User>().expect("not a user"); println!("{} {}", e.tag, user.name); }\n`,
  )

  try {
    execFileSync('rustc', ['-O', '-o', join(dir, 'rust-main'), main], { stdio: 'pipe' })
  } catch (e) {
    ok('rust: the unknown program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400))

    return
  }

  ok('rust: the unknown program builds', true)
  judge('rust', spawnSync(join(dir, 'rust-main'), [], { encoding: 'utf8' }))
}

function runSwift(): void {
  if (!have('swiftc')) {
    return skipped('swift: unknown', 'swiftc not installed')
  }

  const source = emitSwift(frontEnd())
  ok('swift: unknown lowers to Any', /var base: Any\b/.test(source), source.slice(0, 200))
  const main = join(dir, 'main.swift')
  writeFileSync(
    main,
    `${source}\nlet e = holdUser("alice")\nlet kept = carry(e.base)\nlet user = kept as! User\nprint("\\(e.tag) \\(user.name)")\n`,
  )

  try {
    execFileSync('swiftc', ['-o', join(dir, 'swift-main'), main], { stdio: 'pipe' })
  } catch (e) {
    ok('swift: the unknown program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400))

    return
  }

  ok('swift: the unknown program builds', true)
  judge('swift', spawnSync(join(dir, 'swift-main'), [], { encoding: 'utf8' }))
}

function runKotlin(): void {
  if (!have('kotlinc') || !have('java')) {
    return skipped('kotlin: unknown', 'kotlinc/java not installed')
  }

  const source = emitKotlin(frontEnd())
  ok('kotlin: unknown lowers to Any', /var base: Any\b/.test(source), source.slice(0, 200))
  const file = join(dir, 'main.kt')
  writeFileSync(
    file,
    hoistKotlinImports(
      `${source}\nfun main() { val e = holdUser("alice"); val kept = carry(e.base); val user = kept as User; println(e.tag + " " + user.name) }\n`,
    ),
  )
  const jar = join(dir, 'main.jar')

  try {
    execFileSync('kotlinc', [file, '-include-runtime', '-d', jar], { stdio: 'pipe' })
  } catch (e) {
    ok('kotlin: the unknown program builds', false, String((e as { stderr?: Buffer }).stderr ?? e).slice(0, 400))

    return
  }

  ok('kotlin: the unknown program builds', true)
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

console.log(`\nunknown-native: ${pass} pass, ${fail} fail, ${skip} skipped`)

if (fail > 0) {
  process.exit(1)
}
