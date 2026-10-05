// The native prelude takes a shim that another shim calls (device-layer-0016). It took a dock only when the emitted
// code named it, so a shim reached only through another shim was dropped: the Swift location runtime reads its grant
// through `nativePermission`, and an app that read its position and called no permission task failed swiftc with
// `cannot find 'nativePermission' in scope`. Every watcher fans out through `nativeWatch`, which no program names.
//
// Three docks here: `native-a`, which the program calls, `native-b`, which only a's shim calls, and `native-c`, which
// nothing calls and which must stay out. Needs no toolchain. Run: npx tsx test/compile/prelude-reach.ts
import type { Program } from '@term/make/code/compile/node'
import { nativePrelude } from '@term/make/code/compile/native'

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

const dock = (name: string) => ({ form: 'native', module: `global:${name}`, alias: name, file: '/app/code/view/thing.tree' })
const program = [dock('native-a'), dock('native-b'), dock('native-c')] as unknown as Program

const SHIMS: Record<string, string> = {
  '/app/code/view/runtime/native-a.swift': 'enum nativeA { static func run() { nativeB.help() } }',
  '/app/code/view/runtime/native-b.swift': 'enum nativeB { static func help() {} }',
  '/app/code/view/runtime/native-c.swift': 'enum nativeC { static func idle() {} }',
}
const read = (path: string): string | undefined => SHIMS[path]

const reached = nativePrelude(program, 'swift', read, 'nativeA.run()')
ok('the shim the program calls is taken', reached.includes('enum nativeA'), reached)
ok('and the shim only that shim calls is taken with it', reached.includes('enum nativeB'), reached)
ok('and the shim nothing calls stays out', !reached.includes('enum nativeC'), reached)

const none = nativePrelude(program, 'swift', read, 'print(1)')
ok('a program that calls none of them takes none', none === '', none)

const all = nativePrelude(program, 'swift', read)
ok('without the emitted code every dock is taken, as before', ['nativeA', 'nativeB', 'nativeC'].every(name => all.includes(`enum ${name}`)), all)

const once = nativePrelude([...program, dock('native-b')] as unknown as Program, 'swift', read, 'nativeA.run() nativeB.help()')
ok('a shim two docks reach is taken once', once.split('enum nativeB').length === 2, once)

console.log(`\nprelude-reach: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
