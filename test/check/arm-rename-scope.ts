// After a renaming `link`, a case's later fields are in scope by their own names, as check/arm.tree says ("a field past
// the last name keeps its own") and as the type checker and every emitter read it. check/resolve.ts declared only the
// `link` names, so `case point / link label / back size` was "the name size is not defined" (found porting
// check/text-forms, 2026-10-05). Run: npx tsx test/check/arm-rename-scope.ts
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

const text = `form shape
  case point
    link name, like text
    link size, like number
  case blank

task later-field
  take value, like shape
  like number

  sift value
    case point
      link label
      back size
    case blank
      back -1

task renamed-field
  take value, like shape
  like text

  sift value
    case point
      link label
      back label
    case blank
      back <>
`

const built = compile({ file: 'arm-rename.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('a later field is in scope after a rename', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('a later field is in scope after a rename', true)

  const dir = mkdtempSync(join(tmpdir(), 'term-arm-rename-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => unknown>
  const point = { form: 'point', name: 'n', size: 3 }

  ok('it reads the field', mod.laterField!(point) === 3, String(mod.laterField!(point)))
  ok('and the renamed field reads under its new name', mod.renamedField!(point) === 'n')
}

console.log(`\narm-rename-scope: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
