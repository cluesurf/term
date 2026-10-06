// A module-level `host` of a decimal literal is a DECIMAL. The bridge named its type `number`, from when that was the
// float's name, and `number` is the integer now: `host limit, 5.0` was declared an integer, and Swift, which spells a
// binding's declared type, refused `let limit: Int = 5.0`. TypeScript writes `number` for both and never showed it.
// Found by time/compare through swiftc (self-hosting, 2026-10-04). Run: npx tsx test/compile/host-decimal.ts

import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'

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

const text = 'host limit, 5.0\nhost count, 5\n\ntask over\n  take x, like float\n  like boolean\n  back is-above(x, limit)\n\ntask many\n  take n, like number\n  like boolean\n  back is-above(n, count)\n'
const result = compile({ file: '/gate/code/host.tree', text }, { leanOf: () => true, env: 'swift', entryPoints: ['over', 'many'] })

if (!result.ok) {
  ok('the program builds', false, result.diagnostics.map(d => d.message).join(' | '))
} else {
  const types = new Map(result.program.flatMap(n => (n.form === 'let' ? [[n.name, JSON.stringify(n.type)] as const] : [])))
  // `float`, the type word since D4 (`decimal` is refused): Swift spells it `Double`, never its 32-bit `Float`
  ok('a decimal host is a float', types.get('limit') === '{"kind":"named","name":"float"}', types.get('limit'))
  ok('an integer host is an integer', types.get('count') === '{"kind":"named","name":"integer"}', types.get('count'))

  const node = compile({ file: '/gate/code/host.tree', text }, { leanOf: () => true, entryPoints: ['over', 'many'] })
  const declared = node.ok ? (/const limit: (\w+)/.exec(node.typescript)?.[1] ?? '(none)') : 'failed'
  ok('TypeScript declares it a number, never an undefined `Decimal`', declared === 'number', declared)

  const swift = emitSwift(result.program)
  ok('Swift declares no integer for the decimal', !/limit: Int\b/.test(swift), swift.split('\n').filter(l => /limit/.test(l)).join(' | '))

  if (spawnSync('swiftc', ['--version']).status !== 0) {
    console.log('skip  swiftc  (not installed)')
  } else {
    const dir = mkdtempSync(join(tmpdir(), 'term-host-decimal-'))
    writeFileSync(join(dir, 'main.swift'), swift)
    const out = spawnSync('swiftc', ['-parse-as-library', '-typecheck', join(dir, 'main.swift')], { encoding: 'utf8' })
    ok('swiftc typechecks it', out.status === 0, out.stderr.split('\n').filter(l => /error:/.test(l)).join(' | '))
  }
}

console.log(`\nhost-decimal: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
