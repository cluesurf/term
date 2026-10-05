// A method call inside a text's interpolation: `<value {n/text()}>` on a big integer. Outside a text, `n/text()` is
// the method call; inside one, the bridge read any single word holding a `/` as a PATH (compile/mint-bridge.ts,
// `textExpression`), and the call was dropped in silence: TypeScript emitted `${n.text}`, the method itself, and the
// message read "value undefined". Found by the engine/data/trit port (self-hosting, 2026-10-04). Each case is built
// AND run, beside a field path in an interpolation, which must still read the field.
// Run: npx tsx test/compile/interpolated-call.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { existsSync, readFileSync } from 'node:fs'

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

form point
  link x, like number
  link label, like text

task shown
  like text
  save n, big-from-number(42)
  send back, text <value {n/text()} here>

task field
  like text
  save p
    make point
      bind x, code 3
      bind label, text <a>
  send back, text <at {p/x} named {p/label}>
`

const built = compile({ file: '/gate/code/interpolated-call.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!) })

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const prelude = nativePrelude(built.program, 'node', path => (existsSync(path) ? readFileSync(path, 'utf8') : undefined))
  const dir = mkdtempSync(join(tmpdir(), 'term-interpolated-call-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(`${prelude}\n${built.typescript}`, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { shown: () => string; field: () => string }
  ok('a method call in an interpolation is called', mod.shown() === 'value 42 here', mod.shown())
  ok('a field path in an interpolation still reads the field', mod.field() === 'at 3 named a', mod.field())
}

console.log(`\ninterpolated-call: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
