// An empty list or map bound with `host` (the immutable binding) learns its element from use, as one bound with `save`
// does. The lean `make list` arrives as an empty ARRAY literal, and check/scheme.ts counted an array literal a syntactic
// value, so the binding was generalized: each use got a fresh element and the binding's own was never solved. Rust held
// `Vec<Rc<dyn Any>>` and Swift and Kotlin `[Any]`, which refused the program, while TypeScript's `any` hid it. Found by
// the time/profile port (self-hosting, 2026-10-04). The program is built for Rust, compiled with rustc and RUN.
// Run: npx tsx test/check/host-list.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

load @term/base/hash
  find hash

task by-member
  take items, like list, like text
  like number

  host seen, make list
  walk items
    take item
    seen/push(item)

  back seen/length

task by-call
  take items, like list, like text
  like number

  host seen, make list
  walk items
    take item
    push(seen, item)

  back seen/length

task counted
  take items, like list, like text
  like number

  host counts, make hash
  walk items
    take item
    counts/set(item, add(get-or-default(counts, item, 0), 1))

  back counts/size

task total
  like number

  host words, make list
  words/push(<a>)
  words/push(<bc>)

  back add(add(by-member(words), by-call(words)), counted(words))
`

const built = compile({ file: 'host-list.tree', text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['total'] })

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = `${emitRust(built.program)}\nfn main() {\n    println!("{}", total());\n}\n`
  const unknownLocals = rust.split('\n').filter(l => /let (mut )?(seen|counts|words)\b.*dyn std::any::Any/.test(l))
  ok('no host-bound collection holds an unknown element', unknownLocals.length === 0, unknownLocals.join(' | '))
  ok('the walked list holds text', /let (mut )?seen: Vec<String>/.test(rust), rust.split('\n').filter(l => /let (mut )?seen/.test(l)).join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-host-list-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('it answers 2 + 2 + 2', ran.stdout.trim() === '6', (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nhost-list: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
