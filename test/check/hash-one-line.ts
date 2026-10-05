// The one-line hash type, `like hash, like text, like number`, is a hash of text to number. Each comma nests the next
// `like` under the one before, so the value arrived as the KEY's child: the mill read the key as `text` applied to
// `number` and left the value free. A use that pinned the value hid it. Without one a native backend emitted
// `SeedMap<String, T>` and swiftc refused the program (deck/make/test/affected.tree, 2026-10-04).
// compile/mint-bridge.ts: a primitive key takes no argument, so a `like` under it is the hash's value.
// Run: npx tsx test/check/hash-one-line.ts

import { parse } from '@term/make/code/parser/tree'
import { mill } from '@term/make/code/compile/mill'
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

const resultOf = (like: string, lean: boolean): string => {
  const parsed = parse({ file: 'p.tree', text: `task t\n  ${like}\n  host out, make hash\n  back out\n` })

  if (!parsed.ok) {
    return `parse: ${parsed.diagnostics[0]?.message}`
  }

  const built = mill(parsed.tree, 'p.tree', undefined, lean)

  if (!built.ok) {
    return `mill: ${built.diagnostics[0]?.message}`
  }

  const task = built.program.find(d => (d as { name?: string }).name === 't') as unknown as { returnType?: unknown; result?: unknown; type?: unknown }

  return JSON.stringify(task.returnType ?? task.result ?? task.type)
}

const CASES: [string, string][] = [
  ['like hash, like text, like number', '{"kind":"map","key":{"kind":"string"},"value":{"kind":"number"}}'],
  ['like hash, like text, like list, like text', '{"kind":"map","key":{"kind":"string"},"value":{"kind":"array","element":{"kind":"string"}}}'],
  ['like hash, like number, like boolean', '{"kind":"map","key":{"kind":"number"},"value":{"kind":"boolean"}}'],
]

for (const [like, want] of CASES) {
  for (const lean of [false, true]) {
    const got = resultOf(like, lean)

    ok(`${lean ? 'lean' : 'longhand'}: ${like}`, got === want, got)
  }
}

// the stacked spelling reads as it always did
ok('stacked: like hash / like text / like number', resultOf('like hash\n    like text\n    like number', false) === CASES[0]![1], resultOf('like hash\n    like text\n    like number', false))

// and a native backend sees the value with nothing to infer it from
const built = compile(
  {
    file: 'one-line.tree',
    text: `load @term/base/list
  find list

load @term/base/hash
  find hash

task build
  like hash, like text, like list, like text
  host out, make hash
  host none, make list
  call out/set
    text <none>
    read none
  send back, read out
`,
  },
  { resolve: withNativeEnv('swift', stdlibResolver()!), env: 'swift', entryPoints: ['build'] },
)

if (!built.ok) {
  ok('the program builds for swift', false, built.diagnostics.map(d => `${d.name}: ${d.message}`).join(' | '))
} else {
  const line = emitSwift(built.program).split('\n').find(text => /func build/.test(text)) ?? ''

  ok('Swift emits the hash of text to a list of text', /SeedMap<String, SeedList<String>>/.test(line), line.trim())
}

console.log(`\nhash-one-line: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
