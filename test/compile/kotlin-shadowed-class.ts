// A Term form named like a java.lang class (`form system`) must not take that class away from the Kotlin runtime
// shims, which name it bare (`System.currentTimeMillis()`, `Math.abs`, `Thread.sleep`). Every Kotlin file imports
// java.lang, and a class declared in the file wins over it, so `class System` broke every shim prepended beside it:
// "unresolved reference 'currentTimeMillis'" (deck/test/code/model-check.tree, 2026-10-05). compile/kotlin.ts emits
// such a name with a `Term` prefix, at the declaration and every reference. Held through kotlinc and RUN against
// TypeScript's answer, with a stand-in for a shim appended (the prelude is not part of `emitKotlin`).
// The same holds for `Exception`, which every program loading @term/base/exception declares as `data class Exception<P>`
// (T046, D026), so a first scan, with no kotlinc, fails every bare `Exception` in a type position of a shim under
// deck/base/code/native (`kotlin.Exception` is the spelling).
// Run: npx tsx test/compile/kotlin-shadowed-class.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
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

// every `.kt` under deck/base/code/native, found without a glob
const nativeRoot = join(dirname(fileURLToPath(import.meta.url)), '../../deck/base/code/native')

const kotlinFilesOf = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name)

    return entry.isDirectory() ? kotlinFilesOf(path) : entry.name.endsWith('.kt') ? [path] : []
  })

// a bare `Exception` (no `.` or word character before it, none after it, so `kotlin.Exception`, `java.lang.Exception`
// and `IOException` pass) after `:`, `is`, `as` or `as?`, or inside `<...>`
const bareException = /(?:[:<]\s*|\b(?:is|as\??)\s+)(?<![\w.])Exception\b(?![\w.(])/

const bareExceptionAt = (line: string): boolean => {
  const code = line.replace(/\/\/.*$/, '')

  return !/^\s*(?:\/?\*)/.test(code) && bareException.test(code)
}

// the scan's own rule: each spelling it must flag, each it must let pass
const flagged = ['} catch (e: Exception) {', 'x as? Exception', 'if (x is Exception)', 'val f: Exception? = null', 'List<Exception>']
const passed = ['} catch (e: kotlin.Exception) {', '} catch (e: java.lang.Exception) {', 'catch (e: IOException)', 'catch (e: Throwable)', '// catch (e: Exception)', 'throw RuntimeException("x")']

ok('the scan flags a bare Exception in each type position', flagged.every(bareExceptionAt), flagged.filter(line => !bareExceptionAt(line)).join(' | '))
ok('the scan passes kotlin.Exception, java.lang.Exception, Throwable, longer names and comments', passed.every(line => !bareExceptionAt(line)), passed.filter(bareExceptionAt).join(' | '))

const shims = kotlinFilesOf(nativeRoot)

ok(`the scan reads the Kotlin shims (${shims.length})`, shims.length > 0, nativeRoot)

for (const file of shims) {
  readFileSync(file, 'utf8')
    .split('\n')
    .forEach((line, index) => {
      if (bareExceptionAt(line)) {
        ok(`${relative(nativeRoot, file)}:${index + 1} spells kotlin.Exception`, false, line.trim())
      }
    })
}

ok('no shim names a bare Exception in a type position', shims.every(file => !readFileSync(file, 'utf8').split('\n').some(bareExceptionAt)))

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
