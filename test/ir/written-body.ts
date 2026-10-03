// A body the source wrote never reaches a native backend empty (ir/simplify.ts keepWritten). The native emitters read
// an empty body as a signature-only declaration and emit the not-implemented trap, so a no-op task written as one dead
// binding (`save skip, code 0`) lost it to dead-binding elimination and crashed a macOS app with "stub: push-path"
// (native-navigation-0007). Both directions are held: a written no-op is not a stub, and a declaration still is.
// Run: npx tsx test/ir/written-body.ts

import { compile } from '@term/make/code/compile/compile'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { emitSwift } from '@term/make/code/compile/swift'

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

const PROGRAM = `# a no-op written as one dead binding, the abstract page's convention
task do-nothing
  take path, like text
  save skip, code 0

# declared, never written
task not-written
  take path, like text

task run
  call do-nothing
    text </a>
`

const result = compile({ file: 'written.tree', text: PROGRAM }, { env: 'swift' })
ok('compiles for swift', result.ok, result.ok ? '' : result.diagnostics.map(d => d.message).join(' | '))

if (result.ok) {
  const swift = emitSwift(result.program)
  const kotlin = emitKotlin(result.program)
  ok('swift: the written no-op is not a stub', !swift.includes('stub: do-nothing'), swift.match(/func doNothing[\s\S]*?\n}/)?.[0] ?? '')
  ok('kotlin: the written no-op is not a stub', !kotlin.includes('stub: do-nothing'), kotlin.match(/fun doNothing[\s\S]*?\n}/)?.[0] ?? '')
  ok('swift: a task declared with no body is still the trap', swift.includes('stub: not-written'))
  ok('kotlin: a task declared with no body is still the trap', kotlin.includes('stub: not-written'))
}

console.log(`\nwritten-body: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
