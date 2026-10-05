// A call that hands a shared list over and reads the same list in another argument: `set(items, 0, get(items, 2))`.
// Rust emitted `list_set(items.clone(), 0, list_get(&items.borrow(), 2))`, whose `Ref` lives to the semicolon, so the
// callee's `borrow_mut` panicked with "RefCell already borrowed". It built clean and failed only when run. Found by
// deck/base/test/edge-random.tree (`shuffle`), on 2026-10-04; compile/rust.ts now evaluates such arguments into locals
// first, in order. The program is built, compiled with rustc and RUN, and its answer held against TypeScript's.
// Run: npx tsx test/compile/rust-cell-argument.ts

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
  find list

task swap
  like text
  save items, make list
  call items/push
    text <a>
  call items/push
    text <b>
  call items/push
    text <c>
  save held, call items/get, code 0
  call items/set
    code 0
    call items/get
      code 2
  call items/set
    code 2
    read held
  send back, text <{{call(items/get, code 0)}}{{call(items/get, code 1)}}{{call(items/get, code 2)}}>
`

const want = 'cba'

const node = compile({ file: 'swap.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['swap'] })

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-cell-argument-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { swap: () => string }
  ok('TypeScript swaps through set and get', mod.swap() === want, mod.swap())
}

const built = compile({ file: 'swap.tree', text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['swap'] })

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = `${emitRust(built.program)}\nfn main() {\n    println!("{}", swap());\n}\n`
  ok('no argument borrows the cell a sibling argument hands over', !/list_set\(items\.clone\(\), [^;]*items\.borrow\(\)/.test(rust), rust.split('\n').filter(l => /list_set\(items/.test(l)).join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-cell-argument-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does, without a borrow panic', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nrust-cell-argument: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
