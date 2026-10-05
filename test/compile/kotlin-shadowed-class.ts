// A Term form named like a java.lang class (`form system`) must not take that class away from the Kotlin runtime
// shims, which name it bare (`System.currentTimeMillis()`, `Math.abs`, `Thread.sleep`). Every Kotlin file imports
// java.lang, and a class declared in the file wins over it, so `class System` broke every shim prepended beside it:
// "unresolved reference 'currentTimeMillis'" (deck/test/code/model-check.tree, 2026-10-05). compile/kotlin.ts emits
// such a name with a `Term` prefix, at the declaration and every reference. Held through kotlinc and RUN against
// TypeScript's answer, with a stand-in for a shim appended (the prelude is not part of `emitKotlin`).
// Run: npx tsx test/compile/kotlin-shadowed-class.ts

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

const text = `form system
  link steps, like integer

form math
  case linear
    link slope, like integer
  case flat

task total
  like integer
  save s
    make system
      bind steps, code 3
  save m
    make linear
      bind slope, code 4
  fork case, read m
    case linear
      send back
        call add
          read s/steps
          read slope
    case flat
      send back, read s/steps
`

const want = '7'

const node = compile({ file: 'shadow.tree', text }, { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['total'] })

if (!node.ok) {
  ok('the program builds for node', false, node.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const dir = mkdtempSync(join(tmpdir(), 'term-kotlin-shadow-'))
  const file = join(dir, 'module.mjs')
  writeFileSync(file, transformSync(node.typescript, { loader: 'ts', format: 'esm' }).code)
  const mod = (await import(pathToFileURL(file).href)) as { total: () => number | bigint }
  ok('TypeScript answers 7', String(mod.total()) === want, String(mod.total()))
}

const built = compile({ file: 'shadow.tree', text }, { resolve: withNativeEnv('kotlin', stdlibResolver()!), env: 'kotlin', entryPoints: ['total'] })

if (!built.ok) {
  ok('the program builds for kotlin', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  // the stand-in for a runtime shim: bare `System` and `Math`, as clock.kt and compare.kt write them
  const shim = 'object stamp {\n    fun now(): Long = System.currentTimeMillis()\n    fun gap(a: Double, b: Double): Double = Math.abs(a - b)\n}\n'
  const kotlin = `${shim}\n${emitKotlin(built.program)}\nfun main() {\n    stamp.now()\n    println(total())\n}\n`
  ok('the forms are declared with the prefix', /class TermSystem\b/.test(kotlin) && /class TermMath\b/.test(kotlin), kotlin.split('\n').filter(l => /class /.test(l)).join(' | '))
  ok('no class takes a java.lang name', !/class (System|Math)\b/.test(kotlin))

  const kotlinc = spawnSync('kotlinc', ['-version'], { encoding: 'utf8' })

  if (kotlinc.status !== 0) {
    console.log('skip  kotlinc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-kotlin-shadow-'))
    writeFileSync(join(dir, 'main.kt'), kotlin)
    const jar = join(dir, 'main.jar')
    const out = spawnSync('kotlinc', [join(dir, 'main.kt'), '-include-runtime', '-nowarn', '-d', jar], { encoding: 'utf8' })
    ok('kotlinc compiles it, the shim reaching java.lang', out.status === 0, out.stderr.split('\n').filter(l => /error:/.test(l)).join(' | '))

    if (out.status === 0) {
      const ran = spawnSync('java', ['-jar', jar], { encoding: 'utf8' })
      ok('Kotlin answers what TypeScript does', ran.stdout.trim() === want, (ran.stdout + ran.stderr).trim())
    }
  }
}

console.log(`\nkotlin-shadowed-class: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
