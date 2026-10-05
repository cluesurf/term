// An empty collection stored into a native collection takes the slot's type, known then or only later. `pin` in
// check/infer.ts linked an argument to the slot only when the argument was ground, so `host none, make list` then
// `graph/set(<log>, none)` left `none` a list of anything once `back graph` settled the hash, and Swift emitted
// `SeedList<Any>` where a `SeedList<String>` goes (deck/make/test/affected.tree on the base gate, 2026-10-04).
// Rust and TypeScript never spell the element there, which hid it. Held on the checked type and on Swift.
// Run: npx tsx test/check/empty-collection-argument.ts

import { compile } from '@term/make/code/compile/compile'
import { emitSwift } from '@term/make/code/compile/swift'
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

load @term/base/hash
  find hash

task into-hash
  like hash
    like text
    like list, like text
  host graph, make hash
  host none, make list
  call graph/set
    text <log>
    read none
  send back, read graph

task into-hash-saved
  like hash
    like text
    like list, like text
  host graph, make hash
  save none, make list
  call graph/set
    text <log>
    read none
  send back, read graph

task into-list
  like list
    like list, like number
  host outer, make list
  host none, make list
  call outer/push
    read none
  send back, read outer

task empty-hash-into-list
  like list
    like hash
      like text
      like boolean
  host outer, make list
  host none, make hash
  call outer/push
    read none
  send back, read outer
`

const names = ['into-hash', 'into-hash-saved', 'into-list', 'empty-hash-into-list']
const want: Record<string, string> = {
  'into-hash': '{"kind":"array","element":{"kind":"string"}}',
  'into-hash-saved': '{"kind":"array","element":{"kind":"string"}}',
  'into-list': '{"kind":"array","element":{"kind":"number"}}',
  'empty-hash-into-list': '{"kind":"map","key":{"kind":"string"},"value":{"kind":"boolean"}}',
}

const built = compile(
  { file: 'empty-argument.tree', text },
  { resolve: withNativeEnv('swift', stdlibResolver()!), env: 'swift', entryPoints: names },
)

if (!built.ok) {
  ok('the program builds for swift', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  for (const name of names) {
    const task = built.program.find(d => (d as { name?: string }).name === name) as unknown as { body: { form: string; name?: string; type?: unknown }[] }
    const none = task.body.find(s => s.form === 'let' && s.name === 'none')

    ok(`${name}: the empty collection takes the slot's type`, JSON.stringify(none?.type) === want[name], JSON.stringify(none?.type))
  }

  const swift = emitSwift(built.program)

  ok('Swift spells no element as Any', !/SeedList<Any>|\[Any\]|SeedMap<String, Any>/.test(swift), swift.split('\n').filter(line => /Any/.test(line) && /none/.test(line)).join(' | '))
}

console.log(`\nempty-collection-argument: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
