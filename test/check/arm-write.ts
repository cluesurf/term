// Inside `sift x / case c`, `x/field` reads and writes case `c` of x's OWN form, even where another form has a case of
// that name. Until 2026-10-05 the field was looked up by the label alone, so with node.tree's expression and view node
// both declaring `call`, `value/background` inside `case call` over an expression was refused as no field of the view
// node's case, and the emitter held the subject in an alias it then wrote around. A rewriting pass is written this way
// (check/pending.tree). Run: npx tsx test/check/arm-write.ts

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

// `node` declares `call` first with a `value` field; `shape`, declared after it, has a `call` with others
const text = `form node
  case call
    link value, like text
  case other

form shape
  case call
    link name, like text
    link quiet
      like boolean
      need false
  case dot
    link size, like number

task hush
  take one, like shape
  like shape

  sift one
    case call
      save one/quiet, true
      save one/name, <{one/name}!>
      back one
    case dot
      save one/size, add(one/size, 1)
      back one
`

const built = compile({ file: 'arm-write.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), library: true, leanOf: () => true } as never)

if (!built.ok) {
  ok('a write to the matched case builds', false, built.diagnostics.map(d => d.message).join(' | '))
} else {
  ok('a write to the matched case builds', true)
  const at = built.typescript.indexOf('function hush')
  const body = built.typescript.slice(at, at + 300)
  ok('the subject is matched by its own name, so the write is narrowed', /if \(one\.form === "call"\)/.test(body) && !/__at/.test(body), body)

  const dir = mkdtempSync(join(tmpdir(), 'term-arm-write-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(built.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as Record<string, (...a: unknown[]) => any>

  const called = mod.hush!({ form: 'call', name: 'go' })
  ok('the fields of the case are written', called.quiet === true && called.name === 'go!', JSON.stringify(called))
  ok('in the other case too', mod.hush!({ form: 'dot', size: 2 }).size === 3)
}

console.log(`\narm-write: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
