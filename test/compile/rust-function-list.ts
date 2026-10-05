// A list of task values on Rust. Each task is a type of its own there (an fn item), so `make list(double, negate)`
// emitted `vec![Rc::new(double), Rc::new(negate)]` and rustc refused it (E0308, "expected fn item, found a different
// fn item"). Each item is cast to the list's element, the `Rc<dyn Fn>` it holds. Found by
// deck/test/test/fold-synthesis.tree's list of specs on the base gate, 2026-10-05. Held through rustc and RUN.
// Run: npx tsx test/compile/rust-function-list.ts

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

task double
  take x, like number
  like number
  send back
    call add
      read x
      read x

task negate
  take x, like number
  like number
  send back
    call subtract
      code 0
      read x

task apply-all
  take fns
    like list
      like task
        take x, like number
        like number
  take x, like number
  like number
  save total, code 0
  walk list, read fns
    hook next
      take site, name f
      save total
        call add
          read total
          call f
            read x
  send back, read total

task run
  like number
  save fns
    make list
      read double
      read negate
  send back
    call apply-all
      read fns
      code 5
`

const want = '5'

const built = compile(
  { file: 'function-list.tree', text },
  { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['run'] },
)

if (!built.ok) {
  ok('the program builds for rust', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = emitRust(built.program)
  const line = rust.split('\n').find(text => /vec!\[/.test(text) && /double/.test(text)) ?? ''

  ok('each task in the list is cast to the element', /double\) as std::rc::Rc<dyn Fn/.test(line), line.trim())

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-rust-function-list-'))
    writeFileSync(join(dir, 'main.rs'), `${rust}\nfn main() {\n    println!("{}", run());\n}\n`)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers 10 + -5', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

// Kotlin, the same family: `mutableListOf(::double, ::negate)` infers `MutableList<KFunction1<..>>`, which the
// invariant `MutableList<Function1<..>>` parameter refuses, so the element is spelled
const onKotlin = compile(
  { file: 'function-list.tree', text },
  { resolve: withNativeEnv('kotlin', stdlibResolver()!), env: 'kotlin', entryPoints: ['run'] },
)

if (!onKotlin.ok) {
  ok('the program builds for kotlin', false, onKotlin.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const kotlin = (await import('@term/make/code/compile/kotlin')).emitKotlin(onKotlin.program)
  const line = kotlin.split('\n').find(text => /mutableListOf/.test(text) && /double/.test(text)) ?? ''

  ok('Kotlin spells the list of functions its element', /mutableListOf<\(Long\) -> Long>\(/.test(line), line.trim())
}

console.log(`\nrust-function-list: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
