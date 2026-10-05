// `pad-left` / `pad-right` of a record's field read in a walk. The Rust lowering of `padStart` / `padEnd` bound its
// receiver as `let o: String = r.name`, which moves the field out of a record the loop only borrows: E0507, and the
// whole file refused. Every other text method borrowed its receiver. Found by the time/table port (self-hosting,
// 2026-10-04); compile/rust.ts now borrows it too and owns it only where it is the answer unchanged. The program is
// built, compiled with rustc and RUN, and its answer held against TypeScript's. Run: npx tsx test/compile/rust-pad-field.ts

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

const text = `load @term/base/text
  find pad-left
  find pad-right

load @term/base/list
  find list

form row
  link name, like text

task table
  like text
  save rows, make list
  call rows/push
    make row
      bind name, text <ab>
  call rows/push
    make row
      bind name, text <abcdef>
  save out, text <>
  walk list, read rows
    hook next
      take site, name r
      save out, text <{{out}}[{{call(pad-right, read(r/name), code(4), text <.>)}}|{{call(pad-left, read(r/name), code(4), text <.>)}}]>
  send back, read out
`

const want = '[ab..|..ab][abcdef|abcdef]'

const node = compile({ file: 'pad.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['table'] })

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-pad-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { table: () => string }
  ok('TypeScript pads a field read in a walk', mod.table() === want, mod.table())
}

const built = compile({ file: 'pad.tree', text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['table'] })

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  // a main that prints the answer, so the binary is held to it (the console module needs its runtime shim on Rust)
  const rust = `${emitRust(built.program)}\nfn main() {\n    println!("{}", table());\n}\n`
  ok('the receiver is borrowed, never moved out of the record', !/let o: String = r\.name/.test(rust), rust.split('\n').filter(l => /let o:/.test(l)).join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-pad-field-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, ran.stdout.trim())
    }
  }
}

console.log(`\nrust-pad-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
