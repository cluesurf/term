// Two Kotlin refusals the engine ports found on 2026-10-04 (engine/data/array, string, value, engine), held through
// kotlinc and RUN against TypeScript's answer.
//   1. A generic union's case holding a LIST of its type argument: the class is `sealed class Vector<out T>` and the
//      field `MutableList<T>`, where T is invariant, so Kotlin refused the class. The field now asserts the variance
//      (`MutableList<@UnsafeVariance T>`).
//   2. An arm field named like a task (`size`): the body read it as the function reference `::size`, since the arm's
//      locals were not locals while its body was emitted.
// Run: npx tsx test/compile/kotlin-arm-field.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformSync } from 'esbuild'
import { compile } from '@term/make/code/compile/compile'
import { emitKotlin } from '@term/make/code/compile/kotlin'
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

form vector
  head t
  case leaf
    link items, like list, like t
    link size, like integer
  case pair
    link left, like vector t
    link right, like vector t
    link size, like integer

task size
  head t
  take v, like vector t
  like integer
  fork case, read v
    case leaf
      send back, read size
    case pair
      send back, read size

task total
  like integer
  save items, make list
  call items/push
    code 4
  save a
    make leaf
      bind items, read items
      bind size, code 1
  save b
    make pair
      bind left, read a
      bind right, read a
      bind size, code 2
  send back
    call add
      call size, read a
      call size, read b
`

const want = '3'

const node = compile({ file: 'vector.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['total'] })

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-kotlin-arm-field-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { total: () => number | bigint }
  ok('TypeScript reads the arm field', String(mod.total()) === want, String(mod.total()))
}

const built = compile({ file: 'vector.tree', text }, { resolve: withNativeEnv('kotlin', stdlibResolver()!), env: 'kotlin', entryPoints: ['total'] })

if (!built.ok) {
  ok('the program builds for kotlin', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const kotlin = `${emitKotlin(built.program)}\nfun main() {\n    println(total())\n}\n`
  ok('the arm field is read as the local, never a function reference', !/return ::size/.test(kotlin), kotlin.split('\n').filter(l => /::size/.test(l)).join(' | '))
  ok('the list field asserts its variance', /MutableList<@UnsafeVariance T>/.test(kotlin), kotlin.split('\n').filter(l => /class VectorLeaf/.test(l)).join(' | '))

  const kotlinc = spawnSync('kotlinc', ['-version'], { encoding: 'utf8' })

  if (kotlinc.status !== 0) {
    console.log('skip  kotlinc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-kotlin-arm-field-'))
    writeFileSync(join(dir, 'main.kt'), kotlin)
    const jar = join(dir, 'main.jar')
    const out = spawnSync('kotlinc', [join(dir, 'main.kt'), '-include-runtime', '-nowarn', '-d', jar], { encoding: 'utf8' })
    ok('kotlinc compiles it', out.status === 0, out.stderr.split('\n').filter(l => /error:/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync('java', ['-jar', jar], { encoding: 'utf8' })
      ok('Kotlin answers what TypeScript does', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nkotlin-arm-field: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
