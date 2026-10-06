// `like decimal` is refused, naming `like float` (note/term/plan/decisions-2026-10.md, D4). `decimal` named the platform
// float, where every other language's library means exact base 10 by it, so the type word went and the name is free for
// a form. Run: npx tsx test/check/decimal-word.ts
//
// Every refusal sits beside the spelling that must still build, so a checker that refused every float fails here.

import { compile } from '@term/make/code/compile/compile'
import { emitKotlin } from '@term/make/code/compile/kotlin'
import { emitRust } from '@term/make/code/compile/rust'
import { emitSwift } from '@term/make/code/compile/swift'

let pass = 0
let fail = 0

function expect(name: string, text: string, want: 'ok' | 'refused'): void {
  const result = compile({ file: 's.tree', text })
  const refusal = result.ok ? undefined : result.diagnostics.find(d => /`like decimal` is the old name of `like float`/.test(d.message))
  const good = want === 'ok' ? result.ok : refusal !== undefined

  if (good) {
    pass++
    console.log(`ok    ${name}${refusal ? `  (${refusal.message})` : ''}`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (ok=${result.ok}, ${result.ok ? '' : result.diagnostics.map(d => d.message).join('; ')})`)
  }
}

expect(
  'a parameter and a result typed `like float` build',
  `task half
  take x, like float
  like float
  send back
    call divide
      read x
      2.0
`,
  'ok',
)

expect(
  'a parameter typed `like decimal` is refused, naming `like float`',
  `task half
  take x, like decimal
  like float
  send back, read x
`,
  'refused',
)

expect(
  'a result typed `like decimal` is refused',
  `task one
  like decimal
  send back, 1.0
`,
  'refused',
)

expect(
  'a field typed `like decimal` is refused',
  `form point
  link x, like decimal
`,
  'refused',
)

expect(
  'an element typed `like decimal` is refused',
  `form path
  link xs, like list, like decimal
`,
  'refused',
)

expect(
  'a float constant with no `like` still builds',
  `host limit, 5.0

task twice
  like float
  send back
    call multiply
      read limit
      2.0
`,
  'ok',
)

expect(
  'the name is free for a form of its own',
  `form decimal
  link digits, like text

task make-one
  like decimal
  send back
    make decimal
      bind digits, <1.5>
`,
  'ok',
)

// and natively that form is the form: every backend once read a named `decimal` as the float, so a program's own
// `form decimal` would have been declared `Double` on Swift and Kotlin
const own = `form decimal
  link digits, like text

task make-one
  like decimal
  send back
    make decimal
      bind digits, <1.5>

task get-digits
  take d, like decimal
  like text
  send back, read d/digits
`

for (const [backend, emit, spelled] of [
  // `DecimalForm`, apart from Foundation's own `Decimal`
  ['swift', emitSwift, /-> DecimalForm\b/],
  ['kotlin', emitKotlin, /\): Decimal\b/],
  ['rust', emitRust, /-> Decimal\b/],
] as const) {
  const result = compile({ file: 's.tree', text: own }, { env: backend, entryPoints: ['make-one', 'get-digits'] })
  const code = result.ok ? emit(result.program) : ''
  const good = result.ok && spelled.test(code) && !/-> Double|\): Double|-> f64/.test(code)

  if (good) {
    pass++
    console.log(`ok    ${backend}: \`form decimal\` is that form, never the float`)
  } else {
    fail++
    console.log(`FAIL  ${backend}: \`form decimal\` is that form  (${result.ok ? code.split('\n').filter(l => /make|digits|Decimal|Double|f64/i.test(l)).slice(0, 6).join(' | ') : result.diagnostics.map(d => d.message).join('; ')})`)
  }
}

console.log(`\ndecimal-word: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
