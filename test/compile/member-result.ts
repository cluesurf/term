// The RESULT of a native collection method called as a member: `xs/slice(1, 3)`, `h/keys()`. The checker typed such a
// call `unknown`, since the method itself has no Term signature, so the Rust emitter treated the result as a boxed value:
// `kept/length` on a slice emitted a FIELD read (`kept.length`), and `walk h/keys()` iterated the shared list itself
// (`for k in Rc<RefCell<Vec>>`), both `rustc` errors. TypeScript, where a property read and a native iteration work on
// anything, never showed it. Found by the engine/data/string and map ports (self-hosting, 2026-10-04).
// Each case is typed (the call's type is read off the checked program) and, where rustc is installed, compiled to Rust.
// Run: npx tsx test/compile/member-result.ts

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

task slice-length
  take xs, like list, like number
  like number
  save kept, call xs/slice, code(1), code 3
  send back, read kept/length

task key-sum
  like number
  save h, make hash
  call h/set, code(1), code 10
  call h/set, code(2), code 20
  save total, code 0
  walk list, call h/keys
    hook next
      take site, name k
      save total, call add, read(total), read k
  send back, read total
`

const built = compile({ file: 'main.tree', text }, { resolve: withNativeEnv('rust', stdlibResolver()!), env: 'rust', entryPoints: ['slice-length', 'key-sum'] })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const rust = emitRust(built.program)
  ok('a slice\'s length is the list\'s length, not a field', !/kept\.length\b/.test(rust), rust.split('\n').filter(l => /kept/.test(l)).join(' | '))
  ok('a walk over keys() borrows the list', !/for \w+ in std::rc::Rc::new\(std::cell::RefCell::new\(/.test(rust), rust.split('\n').filter(l => /for \w+ in/.test(l)).join(' | '))

  const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' })

  if (rustc.status !== 0) {
    console.log('skip  rustc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-member-result-'))
    writeFileSync(join(dir, 'main.rs'), rust)
    const out = spawnSync('rustc', ['--edition', '2021', '--crate-type', 'lib', '-A', 'warnings', '-o', join(dir, 'libmain.rlib'), join(dir, 'main.rs')], { encoding: 'utf8' })
    ok('rustc compiles both', out.status === 0, out.stderr.split('\n').filter(l => /^error/.test(l)).join(' | '))
  }
}

// a value read back out of a native map is the map's value type. Left unknown, it reached TypeScript as `any`, and
// every field read off it went unchecked: time/compare's `by-name/get(name)/mean-ns` emitted `const before: any`
// (self-hosting, 2026-10-04)
{
  const typed = `form side
  link name, like text
  link mean, like float

task mean-of
  take sides, like list, like side
  take name, like text
  like float
  save by-name, make hash
  walk list, read sides
    hook next
      take site, name one
      call by-name/set, read(one/name), read one
  save found, call by-name/get, read name
  send back, read found/mean
`
  const out = compile({ file: 'typed.tree', text: typed }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['mean-of'] })
  const declared = out.ok ? (/const found: ([^=]+) =/.exec(out.typescript)?.[1] ?? '').trim() : out.diagnostics.map(d => d.message).join(' | ')
  ok('a value read from a native map is typed as the map\'s value', declared === 'Side', declared)
}

console.log(`\nmember-result: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
