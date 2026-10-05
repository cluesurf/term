// A case arm that only READS a left-out `need false` list leaves the record as it was; one that writes through it
// puts the list in the record, as the native field holds it. Until 2026-10-05 both put it there (`??=`), so a port
// that walked a type's `args` gave every type it read `args: []`, and the checker tells that from none
// (`if (subject.args)`). compile/typescript.ts `onlyReads`. Run: npx tsx test/compile/arm-list-read.ts

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

const text = `load @term/base/list
  find list

form shape
  case group
    link items
      like list, like number
      need false
  case dot

task total
  take value, like shape
  like number

  save sum, 0
  sift value
    case group
      walk items
        take one
        save sum, add(sum, one)
    case dot
      back 0
  back sum

task size
  take value, like shape
  like number

  sift value
    case group
      back items/length
    case dot
      back 0

task grow
  take value, like shape
  like shape
  mark private

  sift value
    case group
      push(items, 7)
      back value
    case dot
      back value

task grown
  take value, like shape
  like shape

  back grow(value)
`

const built = compile({ file: 'arm-list-read.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('the program builds', false, built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-arm-list-read-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => any>

  const walked = { form: 'group' }
  ok('a walk over a left-out list reads it as empty', mod.total!(walked) === 0)
  ok('and leaves the record as it was', !('items' in walked), JSON.stringify(walked))

  const measured = { form: 'group' }
  ok('its length reads as zero', mod.size!(measured) === 0)
  ok('and leaves the record as it was too', !('items' in measured), JSON.stringify(measured))

  const given = { form: 'group', items: [1, 2] }
  ok('a list that is there is read', mod.total!(given) === 3 && mod.size!(given) === 2)

  const written = mod.grown!({ form: 'group' })
  ok('a write through a left-out list lands in the record', JSON.stringify(written.items) === '[7]', JSON.stringify(written))
}

console.log(`\narm-list-read: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
