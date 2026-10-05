// Constant and copy propagation stop at a scope that rebinds a name. `save at, span` copied `span`, and inside an arm that
// binds its case's own `span` the copy read the arm's field: lint's no-redundant-conditional reported a literal's span
// in place of the conditional's (ir/simplify.ts, found pairing lint/rule-check.tree, 2026-10-05). A renaming `link`
// binds the listed fields under new names AND the rest under their own, which the simplifier did not know either.
// Run: npx tsx test/compile/simplify-arm-capture.ts
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

const text = `form inner
  case point
    link value, like number
    link span, like number
  case blank

form outer
  case pair
    link left, like inner
    link span, like number

# copies the outer span, then reads it inside an arm that binds the inner one, renaming only the first field
task outer-span
  take o, like outer
  like number

  sift o
    case pair
      save at, span
      sift left
        case point
          link kept
          back at
        case blank
          back -1
  back -2

# a constant, read inside an arm that binds a field of the same name
task field-not-constant
  take i, like inner
  like number

  save value, 5
  save copy, value
  sift i
    case point
      back value
    case blank
      back copy
`

const built = compile({ file: 'arm-capture.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-arm-capture-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>

  const pair = { form: 'pair', left: { form: 'point', value: 1, span: 99 }, span: 7 }
  ok('a copy read inside an arm is the copied value, not the arm field of its name', mod.outerSpan!(pair) === 7, String(mod.outerSpan!(pair)))
  ok('a constant name an arm rebinds reads the arm field', mod.fieldNotConstant!({ form: 'point', value: 3, span: 0 }) === 3, String(mod.fieldNotConstant!({ form: 'point', value: 3, span: 0 })))
  ok('and outside such an arm the constant still propagates', mod.fieldNotConstant!({ form: 'blank' }) === 5)
}

console.log(`\nsimplify-arm-capture: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
