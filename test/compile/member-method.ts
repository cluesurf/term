// A Term-defined method of `hash` or `list` called as a MEMBER on a native map or list: `kids/get-or-default(k, d)`,
// `xs/contains(x)`. A member call on a native collection was emitted as the native method of that name, and these are not
// native: TypeScript emitted `kids.getOrDefault(..)`, a TypeError at run time. Found by the engine/data/map port
// (self-hosting, 2026-10-04). `bindMemberMethod` now dispatches such a call to the Term method, and leaves a native member
// (`xs/get(i)`, `h/has(k)`, `xs/push(x)`) to the native call it always was. Built AND run.
// Run: npx tsx test/compile/member-method.ts

import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { nativePrelude, withNativeEnv } from '@term/make/code/compile/native'

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

task lookups
  like number
  save h, make hash
  call h/set, text(<a>), code 1
  save found, call h/get-or-default, text(<a>), code 0
  save missing, call h/get-or-default, text(<b>), code 7
  send back, call add, read(found), read missing

task holds
  like boolean
  save xs, make list
  call xs/push, code 3
  send back, call xs/contains, code 3

task natives
  like number
  save xs, make list
  call xs/push, code 5
  call xs/push, code 6
  send back, call xs/get, code 1
`

const built = compile({ file: '/gate/code/member-method.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!) })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  ok('get-or-default is not emitted as a native method', !/\.getOrDefault\(/.test(built.typescript), built.typescript.split('\n').filter(l => /OrDefault/.test(l)).join(' | '))
  ok('a native member stays native: xs/get is an index read', !/listGet\(xs/.test(built.typescript))

  const prelude = nativePrelude(built.program, 'node', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const dir = mkdtempSync(join(tmpdir(), 'term-member-method-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(`${prelude}\n${built.typescript}`, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, () => unknown>
  ok('h/get-or-default runs: 1 found, 7 by default', mod.lookups!() === 8, String(mod.lookups!()))
  ok('xs/contains runs', mod.holds!() === true, String(mod.holds!()))
  ok('xs/get still reads the element', mod.natives!() === 6, String(mod.natives!()))
}

console.log(`\nmember-method: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
