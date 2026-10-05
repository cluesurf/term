// A list literal of a union's cases names its element on Swift and Kotlin. Swift wrote `SeedList([.int, .int])`, and
// a case written `.int` needs its enum ("reference to member 'int' cannot be resolved without a contextual type");
// Kotlin wrote `mutableListOf(ShapeInt, ShapeInt)`, a `MutableList<ShapeInt>` the invariant `MutableList<Shape>`
// parameter refuses. Found by deck/test/test/property-check.tree on the base gate, 2026-10-05.
// Run: npx tsx test/compile/union-list-native.ts

import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'
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

form shape
  case int
  case wave
  case tuple
    link items, like list, like shape

task count-of
  take value, like shape
  like number
  fork case, read value
    case tuple
      send back, read items/length
    hook miss
      send back, code 0

task run
  like number
  save parts
    make list
      make int
      make wave
  send back
    call count-of
      make tuple
        bind items, read parts
`

for (const [env, emit, want] of [
  ['swift', emitSwift, /SeedList<Shape>\(\[/],
  ['kotlin', emitKotlin, /mutableListOf<Shape>\(/],
] as const) {
  const built = compile({ file: 'union-list.tree', text }, { resolve: withNativeEnv(env, stdlibResolver()!), env, entryPoints: ['run'] })

  if (!built.ok) {
    ok(`the program builds for ${env}`, false, built.diagnostics.map(d => d.message).join(' | '))
    continue
  }

  const source = emit(built.program)
  const line = source.split('\n').find(l => /SeedList|mutableListOf/.test(l) && /(Int|int)/.test(l) && !/^\s*(func|fun|final|class|@)/.test(l)) ?? ''

  ok(`${env}: the list of cases names its element`, want.test(line), line.trim())
}

console.log(`\nunion-list-native: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
