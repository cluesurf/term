// A case arm's field shadows an outer variable of its name in the kernel too, with a `miss` arm. The kernel's statement
// path checked each arm in the OUTER scope, binding no fields, so `case number / back value` beside a parameter named
// `value` was checked as returning the parameter: "kernel: type mismatch, expected Number, found sample" for a program
// the surface checker accepts and every backend emits right. The eliminator path (every case named, no `miss`) already
// declined on a field. check/elaborate.ts now takes each arm's locals out of scope, so a use of one declines too.
// Found by deck/test/code/property-check.tree, 2026-10-05. Run: npx tsx test/check/arm-shadow-kernel.ts

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

task number-in
  take value, like sample
  like number
  fork case, read value
    case number
      send back, read value
${other}

task run
  like number
  send back
    call number-in
      make number
        bind value, code 7
`

const cases: [string, string][] = [
  ['with a miss arm', '    hook miss\n      send back, code 0'],
  ['with every case named', '    case flag\n      send back, code 0'],
]

for (const [label, other] of cases) {
  const built = compile(
    { file: 'shadow.tree', text: program(other) },
    { resolve: withNativeEnv('node', stdlibResolver()!), entryPoints: ['run'] },
  )

  ok(`${label}: the field shadows the parameter, and the program builds`, built.ok, built.ok ? '' : built.diagnostics.map(d => d.message.split('\n').join(' ')).join(' | '))

  if (built.ok) {
    ok(`${label}: the arm returns the field`, /const value = __at\d+\.value\s+return value/.test(built.typescript), built.typescript.split('\n').filter(l => /value/.test(l)).join(' | '))
  }
}

console.log(`\narm-shadow-kernel: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
