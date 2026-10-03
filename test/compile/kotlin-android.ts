// Emitted Kotlin calls no JDK 21 List method (codegen-performance-0001). Android builds compile against android-36,
// where `removeLast()`, `removeFirst()`, `getFirst()` and `getLast()` bind to the JDK 21 `java.util.List` methods,
// and those throw NoSuchMethodError on every device below API 35: Term's minimum is 26. The emitter, the Kotlin runtime
// shims and the Android view host are all read, since any of them can write the call.
// Run: npx tsx test/compile/kotlin-android.ts

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { stdlibResolver } from '@term/make/code/resolve'
import type { Source } from '@term/make/code/compile/load'
import { withNativeEnv, nativePrelude } from '@term/make/code/compile/native'
import { emitKotlin } from '@term/make/code/compile/kotlin'

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

const JDK21 = /\.(removeLast|removeFirst|getFirst|getLast)\(\)/g
const base = join(import.meta.dirname, '../../deck/base')
// the stdlib, by the package path rule every resolver calls (`stdlibResolver` in deck/make/code/resolve.ts)
const stdlib = stdlibResolver()!
const readRuntime = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, 'utf8') : undefined)

// 1. programs that pop, shift and walk lists, through the whole emitter and the shims they pull in
for (const fixture of ['lists', 'count', 'text']) {
  const file = join(import.meta.dirname, `meaning-native/${fixture}.tree`)
  const built = compile({ file, text: readFileSync(file, 'utf8') }, { resolve: withNativeEnv('kotlin', stdlib), env: 'kotlin' })

  if (!built.ok) {
    ok(`${fixture} builds for kotlin`, false, built.diagnostics.map(d => d.message).join(' | ').slice(0, 300))
    continue
  }

  const source = `${nativePrelude(built.program, 'kotlin', readRuntime)}\n${emitKotlin(built.program)}`
  const found = [...source.matchAll(JDK21)].map(m => m[0])
  ok(`${fixture}: no JDK 21 List method in the emitted Kotlin`, found.length === 0, found.join(', '))
}

// 2. every Kotlin runtime shim and the Android view host, read as written
const dirs = [join(base, 'code/native/kotlin/runtime'), join(import.meta.dirname, '../../deck/site/code/dom/native/toolkit/runtime')]

for (const dir of dirs) {
  for (const name of readdirSync(dir).filter(n => n.endsWith('.kt'))) {
    const found = [...readFileSync(join(dir, name), 'utf8').matchAll(JDK21)].map(m => m[0])
    ok(`${name}: no JDK 21 List method`, found.length === 0, found.join(', '))
  }
}

console.log(`\nkotlin-android: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
