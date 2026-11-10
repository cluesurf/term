// The answers of guarded blocks and of a closure sent back at a raising task type on Rust (item
// term-self-host-001-1101 of term/self-host/change/001-finish-self-host, found by 1059), one program per shape
// (T-1091), each held through rustc and RUN against TypeScript's answer:
//   fresh-guard     a guard in a task answering a fresh list: the body's answer was `Option<Rc<RefCell<Vec<T>>>>`
//                   while the task answers the `Vec` (E0308 expected `Vec<String>`, found `Rc<RefCell<Vec<String>>>`:
//                   compiler-hunt.tree fuzz-seeds-from, halting.tree other-remote-mounts)
//   nested-guard    a guard inside a guard: the inner match's `return` left the OUTER body with the task's own answer
//                   (`Ok(v)` or `v`) where that body answers `Ok(Some(v))` (E0308 expected `()`, found `Option<_>`:
//                   build-command.tree write-roll)
//   raising-closure a closure sent back as a task's result whose declared task type raises was written as a plain
//                   closure, its `back` lines bare (E0308 expected `Result<String, TermException>`, found `String`:
//                   unit-naming.tree unit-path)
// Run: npx tsx test/compile/rust-guard-returns.ts

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
    name: 'fresh-guard',
    text: `load @term/base/list
  find push

task kept
  take files, like list, like text
  like list, like text
  save out, make list
  walk files
    take file
    fork
      mark unsafe
      fork test, is-equal(file, <bad>)
        hold
          halt <unreadable>
      push(out, file)
    halt take
      take problem
  back out

task check
  like text
  save given, make list
  push(given, <a>)
  push(given, <bad>)
  push(given, <b>)
  save said, <>
  walk kept(given)
    take one
    save said, <{said}{one}>
  back said
`,
    want: 'ab',
  },
  {
    name: 'nested-guard',
    text: `task found
  take given, like text
  like text
  fork
    mark unsafe
    fork
      mark unsafe
      fork test, is-equal(given, <x>)
        hold
          halt <inner>
      back <inner {given}>
    halt take
      take problem
      back <caught>
  halt take
    take problem
  back <fell>

task check
  like text
  back <{found(<a>)}|{found(<x>)}>
`,
    want: 'inner a|caught',
  },
  {
    name: 'raising-closure',
    text: `task joiner
  take tail, like text
  like task
    take head, like text
    like text
    halt failure
  save glue, <{tail}>
  back
    task
      take head, like text
      like text
      fork test, is-equal(head, <>)
        hold
          back glue
      back <{head}{glue}>

task check
  like text
  save made, joiner(<!>)
  save other, joiner(<?>)
  back <{made(<a>)}|{made(<>)}|{other(<b>)}>
`,
    want: 'a!|!|b?',
  },
]

const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })
const leanOf = (file: string): boolean => file.endsWith('shape.tree')

for (const shape of shapes) {
  const node = compile(
    { file: '/gate/code/shape.tree', text: shape.text },
    { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: ['check'] },
  )
  if (!node.ok) {
    ok(`${shape.name}: builds for node`, false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-guard-returns-'))
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

console.log(`\nrust-guard-returns: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
