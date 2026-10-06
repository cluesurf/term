// An arm that binds a field named like its own subject (`sift value / case whole`, the case's one field `value`) reads
// that FIELD by the name for the whole arm, paths included. Until 2026-10-05 the subject stayed narrowed beside it, so
// `value/shown()` was read as a field `shown` of the subject's `whole` case, which has none, and the call was refused
// ("this function expects 1 arguments, found 0"): engine/backend/typescript-text.tree's `value/text()` on a big
// integer literal, found while porting it. The bare read was always the field (engine/engine.tree reads it so).
// Run: npx tsx test/check/arm-subject-field.ts

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

const text = `form box
  link count, like number

  task shown
    take self
    like text

    back <box {self/count}>

form literal
  case small, like number
  case whole, like box

form shape
  case integer
    link value, like literal
  case other

task show
  take node, like shape
  like text

  sift node
    case integer
      sift value
        case small
          back <small {value}>
        case whole
          save written, value/shown()
          back written
    case other
      back <other>

task count-of
  take value, like literal
  like number

  sift value
    case small
      back value
    case whole
      back value/count
`

const built = compile({ file: 'arm-subject-field.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('a path off a field named like the subject builds', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('a path off a field named like the subject builds', true)

  const dir = mkdtempSync(join(tmpdir(), 'term-arm-subject-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => any>

  const whole = mod.show!({ form: 'integer', value: { form: 'whole', value: { count: 7 } } })
  ok('a method called on the field answers', whole === 'box 7', JSON.stringify(whole))
  ok('the bare field reads as before', mod.show!({ form: 'integer', value: { form: 'small', value: 3 } }) === 'small 3')
  ok('a field read off the field is its own', mod.countOf!({ form: 'whole', value: { count: 9 } }) === 9)
  ok('and the payload case reads its value', mod.countOf!({ form: 'small', value: 4 }) === 4)
}

console.log(`\narm-subject-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
