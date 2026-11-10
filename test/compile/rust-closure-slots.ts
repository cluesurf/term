// Closures with no slot to type them on Rust (items term-self-host-001-1109, 1110 and 1111 of
// term/self-host/change/001-finish-self-host, found by 1105), one program per shape (T-1091), each held through rustc
// and RUN against TypeScript's answer:
//   let-closure      a closure saved in a let was written `move |name| ...` with its declared parameter left bare, so
//                    rustc could not type it (E0282 type annotations needed: runtime_exports camel, emit_kotlin size_of)
//   dynamic-closure  a closure sent back as `like dynamic` the same (E0282: face_project_resolver, boot_resolver_face)
//   hash-has         a bare text parameter read by `known/has(name)` was taken for `str` (E0277 the size for values
//                    of type `str` cannot be known: clean_test, emit_kotlin is_build)
//   handed-on        that closure handed on to a task-typed parameter (E0631 type mismatch in closure arguments:
//                    emit_rust_pass lists, emit_kotlin is_build)
//   raising-let      a non-raising closure saved in a let INSIDE a closure and handed to a raising task slot went in
//                    as it was, with no `Ok` adapter (E0271 expected the closure to return Result<bool, TermException>:
//                    emit_kotlin failed-once, item 1110)
//   raising-let-top  the same let at a task's own level, the twin that held already
//   dynamic-async    an async closure declared `like dynamic` whose body falls off its end resolved to `()` (E0271
//                    expected the async block to resolve to Rc<dyn Any>: layout_transport, item 1111)
//   dynamic-sync     its sync twin
// Run: npx tsx test/compile/rust-closure-slots.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv } from '@term/make/code/compile/native'

let pass = 0
let fail = 0

function ok(name: string, holds: boolean, detail = ''): void {
  if (holds) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}${detail ? `\n        ${detail}` : ''}`)
  }
}

const shapes: { name: string; text: string; want: string }[] = [
  {
    name: 'let-closure',
    text: `task shout
  take word, like text
  like text
  save loud, <{word}!>
  back loud

task check
  like text
  save cry
    task
      take name, like text
      like text
      save said, shout(name)
      back said
  back <{cry(<a>)}{cry(<b>)}>
`,
    want: 'a!b!',
  },
  {
    name: 'dynamic-closure',
    text: `task maker
  take tail, like text
  like dynamic
  save glue, <{tail}>
  back
    task
      take head, like text
      like text
      save said, shout(<{head}{glue}>)
      back said

task shout
  take word, like text
  like text
  save loud, <{word}!>
  back loud

task check
  like text
  save made, maker(<!>)
  save other, maker(<?>)
  back <made>
`,
    want: 'made',
  },
  {
    name: 'hash-has',
    text: `task check
  like text
  save known, make hash
  known/set(<a>, true)
  save seen
    task
      take name, like text
      like boolean
      save found, known/has(name)
      back found
  back <{seen(<a>)}|{seen(<b>)}>
`,
    want: 'true|false',
  },
  {
    name: 'handed-on',
    text: `load @term/base/list
  find push

task count-kept
  take names, like list, like text
  take keep
    like task
      take name, like text
      like boolean
  like number
  save n, 0
  walk names
    take one
    fork test, keep(one)
      hold
        save n, add(n, 1)
  back n

task check
  like text
  save known, make hash
  known/set(<a>, true)
  save seen
    task
      take name, like text
      like boolean
      save found, known/has(name)
      back found
  save given, make list
  push(given, <a>)
  push(given, <b>)
  push(given, <a>)
  back <{count-kept(given, seen)}>
`,
    want: '2',
  },
  {
    name: 'raising-let',
    text: `task tries
  take reason, like text
  take fail
    like task
      take reason, like text
      like boolean
      halt failure
  like boolean
  save said, fail(reason)
  back said

task check
  like text
  save run
    task
      like text
      save failed-once
        task
          take reason, like text
          like boolean
          save note, <{reason}?>
          back is-equal(note, <x?>)
      save got, tries(<x>, failed-once)
      back <{got}>
  save said, run()
  back <{said}>
`,
    want: 'true',
  },
  {
    name: 'raising-let-top',
    text: `task tries
  take reason, like text
  take fail
    like task
      take reason, like text
      like boolean
      halt failure
  like boolean
  save said, fail(reason)
  back said

task check
  like text
  save failed-once
    task
      take reason, like text
      like boolean
      save note, <{reason}?>
      back is-equal(note, <x?>)
  save got, tries(<x>, failed-once)
  back <{got}>
`,
    want: 'true',
  },
  {
    name: 'dynamic-async',
    text: `task settle
  take dir, like text
  mark async
  save note, <{dir}/>
  save more, <{note}!>

task keep-it
  take given, like dynamic
  like text
  save said, <kept>
  back said

task check
  like text
  save dir, <d>
  save starter
    task
      like dynamic
      mark async
      settle(dir)
  back keep-it(starter)
`,
    want: 'kept',
  },
  {
    name: 'dynamic-sync',
    text: `task settle
  take dir, like text
  save note, <{dir}/>
  save more, <{note}!>

task keep-it
  take given, like dynamic
  like text
  save said, <kept>
  back said

task check
  like text
  save dir, <d>
  save starter
    task
      like dynamic
      settle(dir)
  save ran, starter()
  back keep-it(starter)
`,
    want: 'kept',
  },
]

const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
const leanOf = (file: string): boolean => file.endsWith('shape.tree')
const only = process.env.ONLY

for (const shape of shapes) {
  if (only && shape.name !== only) continue
  const node = compile(
    { file: '/gate/code/shape.tree', text: shape.text },
    { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: ['check'] },
  )
  if (!node.ok) {
    ok(`${shape.name}: builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-slots-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { check: () => string }
  const answer = String(mod.check())
  ok(`${shape.name}: TypeScript answers`, answer === shape.want, answer)

  const built = compile(
    { file: '/gate/code/shape.tree', text: shape.text },
    { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: ['check'] },
  )
  if (!built.ok) {
    ok(`${shape.name}: builds for rust`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const emitted = emitRust(built.program)
  if (process.env.SHOW) writeFileSync(`${process.env.SHOW}-${shape.name}.rs`, emitted)
  const unwrap = /fn check\([^)]*\) -> std::result::Result/.test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}", check()${unwrap});\n}\n`
  if (rustc.status !== 0) {
    console.log(`skip  ${shape.name}: rustc  (not installed)`)
    continue
  }
  writeFileSync(join(dir, 'main.rs'), rust)
  const binary = join(dir, 'main')
  const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
    encoding: 'utf8',
  })
  const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
  ok(`${shape.name}: rustc compiles it`, out.status === 0, errors.join(' | '))
  if (out.status === 0) {
    const ran = spawnSync(binary, [], { encoding: 'utf8' })
    ok(`${shape.name}: Rust answers what TypeScript does`, ran.stdout.trim() === shape.want, ran.stdout.trim())
  }
}

console.log(`\nrust-closure-slots: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
