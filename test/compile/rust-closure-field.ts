// Two Rust defects the repair-loop port found (self-hosting, 2026-10-04), held through rustc and RUN against
// TypeScript's answer:
//   1. a call through a CLOSURE FIELD (`(b.apply)(items, n)`) whose argument borrows the list another argument hands
//      over: compile/rust.ts hoisted that argument into `__lend_1`, but the closure-field path skipped the wrapper that
//      declares it, so rustc found `__lend_1` named and never declared (E0425)
//   2. a record built from a FUNCTION-typed field of another (`make box / bind apply, b/apply`) inside a loop: a
//      function-typed value was never cloned, and a field of function type is an `Rc<dyn Fn>`, so the first turn moved
//      it out of `b` and the second used it moved (E0382)
// Run: npx tsx test/compile/rust-closure-field.ts

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

form box
  link apply
    like task
      take items, like list, like number
      take n, like number
      like number
  link items, like list, like number

task total-of
  take items, like list, like number
  take n, like number
  like number
  send back
    call add
      call size
        read items
      read n

task run
  like number
  save items, make list
  call items/push
    code 1
  call items/push
    code 2
  save b
    make box
      bind apply, read total-of
      bind items, read items
  save sum, code 0
  save k, code 0
  walk test
    hook test
      call is-below
        read k
        code 3
    hook hold
      save again
        make box
          bind apply, read b/apply
          bind items, read b/items
      save sum
        call add
          read sum
          call again/apply
            read items
            call size
              read items
      save k
        call add
          read k
          code 1
  send back, read sum
`

const want = '12'

const node = compile({ file: 'closure-field.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['run'] })

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => number }
  ok('TypeScript answers 3 turns of 2 + 2', String(mod.run()) === want, String(mod.run()))
}

const built = compile({ file: 'closure-field.tree', text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['run'] })

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = `${emitRust(built.program)}\nfn main() {\n    println!("{}", run());\n}\n`
  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-closure-field-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers what TypeScript does', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nrust-closure-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
