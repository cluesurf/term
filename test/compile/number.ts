// What `number` means on every backend: an integer, whose quotient truncates toward zero. Measured on 2026-10-02,
// TypeScript emitted JavaScript's float `/`, so `7 / 2` was 3.5 in a browser and 3 on Rust, Swift and Kotlin. This
// suite RUNS the emitted TypeScript, and reads the native emitters' operator, which is the integer one by type.
// Run: npx tsx test/compile/number.ts. See note/term/proof-by-default/numbers.md.

import { compile } from '@term/make/code/compile/compile'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'
import { emitKotlin } from '@term/make/code/compile/kotlin'

let pass = 0
let fail = 0

function check(name: string, good: boolean, detail: string): void {
  if (good) {
    pass++
    console.log(`ok    ${name}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (${detail})`)
  }
}

const text = `task quotient
  take a, like number
  take b, like number
  like number
  send back
    call divide
      read a
      read b

task remainder
  take a, like number
  take b, like number
  like number
  send back
    call modulo
      read a
      read b

task ratio
  take a, like float
  take b, like float
  like float
  send back
    call divide
      read a
      read b
`

const result = compile({ file: 'number.tree', text }, { optimize: false })

if (!result.ok) {
  console.log(result.diagnostics.map(d => `${d.name}: ${d.message}`).join('\n'))
  process.exit(1)
}

// the emitted module, run: `export` dropped and the three tasks handed back
const run = new Function(
  `${result.typescript.replace(/^export /gm, '').replace(/: (number|float)\b/g, '')}\nreturn { quotient, remainder, ratio }`,
)() as {
  quotient: (a: number, b: number) => number
  remainder: (a: number, b: number) => number
  ratio: (a: number, b: number) => number
}

for (const [a, b, want] of [
  [7, 2, 3],
  [-7, 2, -3],
  [7, -2, -3],
  [-7, -2, 3],
  [6, 3, 2],
] as const) {
  const got = run.quotient(a, b)
  check(`typescript: ${a} / ${b} is ${want}`, got === want, `got ${got}`)
}

for (const [a, b, want] of [
  [7, 2, 1],
  [-7, 2, -1],
  [7, -2, 1],
] as const) {
  const got = run.remainder(a, b)
  check(`typescript: ${a} % ${b} is ${want}, the sign of the dividend`, got === want, `got ${got}`)
}

check('typescript: a float quotient stays a float', run.ratio(7, 2) === 3.5, `got ${run.ratio(7, 2)}`)

// the native backends divide by type: i64, Int and Long all truncate toward zero
for (const [name, emit, type] of [
  ['rust', emitRust, 'i64'],
  ['swift', emitSwift, 'Int'],
  ['kotlin', emitKotlin, 'Long'],
] as const) {
  const out = String((emit as (p: unknown) => unknown)(result.program))
  const signature = out.split('\n').find(line => /quotient/.test(line)) ?? ''
  check(`${name}: number is ${type}, whose / truncates`, signature.includes(type), signature.trim())
}

console.log(`\nnumber: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exitCode = 1
}
