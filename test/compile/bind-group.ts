// A native binding's template under an operator. The stdlib's `bignum-compare` renders as `$a < $b ? -1 : (...)`, and
// the TypeScript emitter put it in place of the call without grouping it, so `is-below(big-compare(x, y), 0)` emitted
// `x < y ? -1 : (...) < 0`: the `< 0` bound to the last arm and the answer was wrong for every x below y. Found by the
// engine/data/integer port (self-hosting, 2026-10-04), whose range check refused every value that fit. Built AND run.
// Run: npx tsx test/compile/bind-group.ts

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

const text = `load @term/base/integer/big
  find big-integer
  find big-from-number
  find big-compare

task below
  take a, like number
  take b, like number
  like boolean
  send back, call is-below, call(big-compare, call(big-from-number, read a), call(big-from-number, read b)), code 0

task above
  take a, like number
  take b, like number
  like boolean
  send back, call is-above, call(big-compare, call(big-from-number, read a), call(big-from-number, read b)), code 0

task shifted
  take a, like number
  take b, like number
  like number
  send back, call add, call(big-compare, call(big-from-number, read a), call(big-from-number, read b)), code 10
`

const built = compile({ file: '/gate/code/bind-group.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!) })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const prelude = nativePrelude(built.program, 'node', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const dir = mkdtempSync(join(tmpdir(), 'term-bind-group-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(`${prelude}\n${built.typescript}`, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (a: number, b: number) => unknown>

  for (const [a, b] of [[1, 2], [2, 1], [3, 3], [-5, 4]] as const) {
    const order = a < b ? -1 : a > b ? 1 : 0
    ok(`is-below(compare(${a}, ${b}), 0) is ${order < 0}`, mod.below!(a, b) === order < 0, String(mod.below!(a, b)))
    ok(`is-above(compare(${a}, ${b}), 0) is ${order > 0}`, mod.above!(a, b) === order > 0, String(mod.above!(a, b)))
    ok(`compare(${a}, ${b}) + 10 is ${order + 10}`, mod.shifted!(a, b) === order + 10, String(mod.shifted!(a, b)))
  }
}

console.log(`\nbind-group: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
