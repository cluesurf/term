// A case arm's renamed field (`case number / link n`) shadows a GLOBAL task of its name in the kernel too. The kernel's
// statement path took each arm local out of scope by deleting it, so a use fell through to the global table: with a
// task `n` anywhere in the program, `back add(n, 1)` was checked against the task, "kernel: type mismatch, expected
// Number, found (many x1 : Number) -> sample". check/elaborate.ts now keeps the local as a key with no level (`hide`),
// and a use declines. Found by deck/test/test/weakest-precondition.tree, whose task `n` met smt-query.tree's
// `case int-value / link n`, 2026-10-05. Run: npx tsx test/check/arm-rename-global.ts

import { compile } from '@term/make/code/compile/compile'
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

const program = (other: string): string => `form sample
  case number
    link value, like number
  case flag
    link value, like boolean

task n
  take value, like number
  like sample
  send back
    make number
      bind value, read value

task number-in
  take s, like sample
  like number
  fork case, read s
    case number
      link n
      send back
        call add
          read n
          code 1
${other}

task run
  like number
  send back
    call number-in
      call n
        code 7
`

const cases: [string, string][] = [
  ['with a miss arm', '    hook miss\n      send back, code 0'],
  ['with every case named', '    case flag\n      send back, code 0'],
]

for (const [label, other] of cases) {
  const built = compile(
    { file: 'rename.tree', text: program(other) },
    { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['run'] },
  )

  ok(`${label}: the renamed field shadows the task n, and the program builds`, built.ok, built.ok ? '' : built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))
}

console.log(`\narm-rename-global: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
