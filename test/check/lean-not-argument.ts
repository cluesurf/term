// `not(...)` written as a lean argument of a method call (`bits/push(not(x))`) is the negation, not a label. The
// mill folds a bare `not` head to `!`, and check/lean-nest.ts folded the binary builtins the same way but not `not`,
// so under a callee with no parameters on record the label stayed: "This call has no parameters on record, so its
// properties (not) name nothing". Found by deck/test/code/abstraction-refinement.tree, which bound the value first to
// get past it (2026-10-05). Run: npx tsx test/check/lean-not-argument.ts

import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
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

const MAIN = `load @term/base/list
  find list

task flips
  take x, like boolean
  take y, like number
  like list, like boolean

  host bits, make list
  bits/push(not(x))
  bits/push(not(is-equal(y, 0)))
  bits/push(and(not(x), true))

  back bits

task run
  like text

  host bits, flips(true, 3)

  back join(bits, <,>)
`

const built = compile(
  { file: 'main.tree', text: MAIN },
  { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['run'], leanOf: () => true } as never,
)

ok('not(...) under a method call builds', built.ok, built.ok ? '' : built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))

if (built.ok) {
  const dir = mkdtempSync(join(tmpdir(), 'term-lean-not-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { run: () => string }

  ok('each one negates: false, true, false', mod.run() === 'false,true,false', mod.run())
}

console.log(`\nlean-not-argument: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
