// Two Rust emitter shapes the CLI's entry refused (finding/native-entry.md of term/self-host/change/001-finish-self-host,
// item term-self-host-001-1057), each held through rustc and RUN, against TypeScript's answer:
//   - a closure that declares a name the task declares too, later: the outer locals are every name the task declares,
//     so the closure cloned `found` before the task had it (`let found = found.clone()`, E0425, at `slot-local-of`)
//   - a `turn next` or `halt` inside a guarded fork, whose loop is outside it: the guard's body is a closure, and rustc
//     refuses a `continue` or `break` inside one (E0267)
// Run: npx tsx test/compile/rust-closure-guard-exit.ts

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

const text = `load @term/base/list
  find push

task pick
  take at, like number
  like number
  save chooser
    task
      take i, like number
      like number
      fork test, is-below(i, 5)
        hold
          save found, add(i, 10)
          back found
      back 0
  save first, chooser(at)
  save found, add(first, 1)
  back found

task count-good
  take items, like list, like number
  like number
  save total, 0
  walk items
    take item
    fork
      mark unsafe
      fork test, is-below(item, 0)
        hold
          turn next
      fork test, is-above(item, 100)
        hold
          halt
      fork test, is-equal(item, 7)
        hold
          halt <seven>
      save total, add(total, item)
    halt take
      take problem
      save total, add(total, 1000)
  back total

task counted
  like number
  save items, make list
  push(items, 1)
  push(items, -2)
  push(items, 3)
  push(items, 7)
  push(items, 4)
  push(items, 200)
  push(items, 5)
  back count-good(items)
`

// pick(3) is 14 and pick(9) is 1; the walk adds 1 and 3, skips -2, catches 7's raise (1000), adds 4, stops at 200
const want = '14|1|1008'
const entries = ['pick', 'counted']
const leanOf = (file: string): boolean => file.endsWith('exits.tree')

const node = compile(
  { file: '/gate/code/exits.tree', text },
  { resolve: withNativeEnv('node', stdlibResolver()!), leanOf, entryPoints: entries },
)

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-guard-exit-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { pick: (n: number) => number; counted: () => number }
  const answer = `${mod.pick(3)}|${mod.pick(9)}|${mod.counted()}`
  ok('TypeScript answers', answer === want, answer)
}

const built = compile(
  { file: '/gate/code/exits.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', leanOf, entryPoints: entries },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const emitted = emitRust(built.program)
  const early = emitted.split('\n').filter(line => /let found = found\.clone\(\)/.test(line))
  ok('the closure clones no name of its own', early.length === 0, early.join(' | '))

  const unwrapOf = (task: string): string =>
    new RegExp(`fn ${task}\\([^)]*\\) -> std::result::Result`).test(emitted) ? '.ok().unwrap()' : ''
  const rust = `${emitted}\nfn main() {\n    print!("{}|{}|{}", pick(3)${unwrapOf('pick')}, pick(9)${unwrapOf('pick')}, counted()${unwrapOf('counted')});\n}\n`

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-guard-exit-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], {
      encoding: 'utf8',
    })
    const errors = out.stderr.split('\n').filter(l => /^error/.test(l))
    ok('rustc compiles it', out.status === 0, errors.join(' | '))
    ok('no continue or break inside a closure (E0267)', !errors.some(l => /E0267/.test(l)), errors.filter(l => /E0267/.test(l)).join(' | '))
    ok('no name cloned before it is declared (E0425)', !errors.some(l => /E0425/.test(l)), errors.filter(l => /E0425/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-closure-guard-exit: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
