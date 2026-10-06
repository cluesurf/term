// A whole-number literal in a field declared `decimal` is a Double on Kotlin (`1.0`), never `1L`, which kotlinc refuses
// ("argument type mismatch: actual type is 'Long', but 'Double' was expected"). Swift's integer literal adapts to its
// slot, so only Kotlin needed it. Found by the font table (native-text-0001), whose `scale` is 1 for most faces.
// Run: npx tsx test/compile/decimal-literal.ts

import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitKotlin, hoistKotlinImports } from '@term/make/code/compile/kotlin'

let pass = 0
let fail = 0

function ok(name: string, cond: boolean, info = ''): void {
  if (cond) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  ${info}`)
  }
}

const PROGRAM = `form face
  link name, like text
  link scale, like float
  link count, like number

task make-face
  like face
  send back
    make face
      bind name, text <plain>
      bind scale, code 1
      bind count, code 2

task report
  like text
  save made
    call make-face
  send back, text <{{made/scale}} {{made/count}}>
`

const result = compile({ file: 'decimal.tree', text: PROGRAM }, { env: 'kotlin' })
ok('compiles for kotlin', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

if (result.ok) {
  const kotlin = emitKotlin(result.program)
  ok('a whole number in a decimal field is written as a Double', /scale = 1\.0\b/.test(kotlin), kotlin.match(/Face\([^)]*\)/)?.[0] ?? '')
  ok('a whole number in a number field stays a Long', /count = 2L\b/.test(kotlin), kotlin.match(/Face\([^)]*\)/)?.[0] ?? '')

  if (spawnSync('which', ['kotlinc']).status === 0 && spawnSync('which', ['java']).status === 0) {
    const dir = mkdtempSync(join(tmpdir(), 'term-decimal-'))
    const file = join(dir, 'main.kt')
    writeFileSync(file, hoistKotlinImports(`${kotlin}\nfun main() { print(report()) }\n`))

    try {
      execFileSync('kotlinc', [file, '-include-runtime', '-d', join(dir, 'main.jar')], { stdio: 'pipe' })
      const said = execFileSync('java', ['-jar', join(dir, 'main.jar')]).toString()
      ok('kotlinc builds it and it runs', said.startsWith('1') && said.endsWith(' 2'), said)
    } catch (error) {
      ok('kotlinc builds it and it runs', false, String((error as { stderr?: Buffer }).stderr ?? error).slice(0, 800))
    }
  } else {
    console.log('skip  kotlinc builds it and it runs: kotlinc or java not installed')
  }
}

console.log(`\ndecimal-literal: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
