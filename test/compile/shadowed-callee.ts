// A parameter or local that shadows a task of its name is called with the arguments written, on every backend. Each
// emitter padded a short call to the arity of the TASK of that name, filling the gap with the type's empty value: the
// stdlib's vector `map` calls its parameter `fn`, so a program defining `task fn` with two `fall` parameters had
// `fn_(x, at, Vec::new(), false)` emitted inside `map`, and rustc refused it (E0057). TypeScript emitted the same extra
// arguments and JavaScript ignored them, so only the native gate saw it (deck/make/test/engine.tree, 2026-10-04).
// Run: npx tsx test/compile/shadowed-callee.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'
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

task fn
  take name, like text
  take extra, like number, fall 7
  take more, like list, like number, fall make list
  like text
  send back, text <{name}{extra}>

task twice
  take x, like number
  like number
  send back
    call add
      read x
      read x

task apply
  take value, like number
  take fn
    like task
      take x, like number
      like number
  like number
  send back
    call fn
      read value

task local-call
  take value, like number
  like number
  save fn, read twice
  send back
    call fn
      read value

task run
  like number
  send back
    call add
      call apply
        code 3
        read twice
      call local-call
        code 4
`

const want = '14'
const entryPoints = ['run', 'apply', 'local-call']
const lines = (source: string, pattern: RegExp): string => source.split('\n').filter(line => pattern.test(line)).join(' | ')

for (const env of ['node', 'rust', 'swift', 'kotlin'] as const) {
  const built = compile(
    { file: 'shadowed-callee.tree', text },
    { resolve: withNativeEnv(env, stdlibResolver()!), ...(env === 'node' ? {} : { env }), entryPoints },
  )

  if (!built.ok) {
    ok(`the program builds for ${env}`, false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
    continue
  }

  const source =
    env === 'node'
      ? built.typescript
      : env === 'rust'
        ? emitRust(built.program)
        : env === 'swift'
          ? emitSwift(built.program)
          : emitKotlin(built.program)
  // the shadowing call, however the backend spells the name `fn` and the argument
  const call = /\bfn_?\((value|value\.clone\(\))\)/

  ok(`${env}: the parameter is called with its one argument`, call.test(lines(source, /fn_?\(value/)), lines(source, /fn_?\(value/))
  ok(`${env}: no call of fn is padded`, !/\bfn_?\(value[^)]*,/.test(source), lines(source, /fn_?\(value/))

  if (env === 'rust') {
    const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

    if (rustc.status !== 0) {
      console.log('skip  rustc  (not installed)')
      continue
    }

    const dir = mkdtempSync(join(tmpdir(), 'term-shadowed-callee-'))
    writeFileSync(join(dir, 'main.rs'), `${source}\nfn main() {\n    println!("{}", run());\n}\n`)
    const binary = join(dir, 'main')
    const out = spawnSync('rustc', ['--edition', '2021', '-A', 'warnings', '-o', binary, join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync(binary, [], { encoding: 'utf8' })
      ok('Rust answers 6 + 8', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nshadowed-callee: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
