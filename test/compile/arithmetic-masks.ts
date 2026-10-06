// ONE ARITHMETIC VOCABULARY, THROUGH MASKS (decisions-2026-10.md, D5). `add`, `subtract`, `multiply` and `divide` on a
// form that wears `addition` (and the rest, @term/base/arithmetic) call the form's own task, and in a task bounded by
// `need addition` they call whatever the caller hands it. `like self` in a mask is the form wearing it. Before this, an
// operator on a form was refused as `arithmetic operand: expected number`, and big integers were added through
// `a/add(b)` or `big-add` only. A form of the test's own and @term/base's `big-integer`, generic and direct, on all four
// backends. Kotlin, which has no `Self`, casts a `like self` result back to the receiver's type.
// Run: sh tmp/run-term-ts.sh test/compile/arithmetic-masks.ts   (MASK_ONLY=typescript, rust, swift or kotlin runs one)

import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { compile } from '@term/make/code/compile/compile'
import { projectResolver } from '@term/call/code/make'
import { BACKENDS, runOn } from './shared/run-on'

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

// a form of its own, wearing `addition` from the stdlib, added generically and directly; numbers still add as numbers
const MONEY = `load @term/base/arithmetic
  find addition

form money
  link cents, like number
  wear addition
    task add
      take self
      take other, like money
      like money
      back make money, bind cents, add(self/cents, other/cents)

task total
  head t, need addition
  take a, like t
  take b, like t
  like t
  back add(a, b)

task run
  like text
  save x, make money, bind cents, 3
  save y, make money, bind cents, 4
  save s, total(x, y)
  save d, add(x, y)
  back <{s/cents} {d/cents} {add(2, 5)}>
`

// the stdlib's big integers, each operator on them, and the generic task over them
const BIG = `load @term/base/integer/big
  find big-integer
  find make-big-integer

load @term/base/arithmetic
  find addition

task total
  head t, need addition
  take a, like t
  take b, like t
  like t
  back add(a, b)

task run
  like text
  save a, make-big-integer(<123456789012345678901234567890>)
  save b, make-big-integer(<987654321098765432109876543210>)
  save sum, add(a, b)
  save difference, subtract(a, b)
  save product, multiply(make-big-integer(<99999999999999999999>), make-big-integer(<3>))
  save quotient, divide(make-big-integer(<1000000000000000000000>), make-big-integer(<7>))
  save generic, total(a, b)
  back <{sum/text()} {difference/text()} {product/text()} {quotient/text()} {generic/text()}>
`

const BIG_EXPECTED = [
  '1111111110111111111011111111100',
  '-864197532086419753208641975320',
  '299999999999999999997',
  '142857142857142857142',
  '1111111110111111111011111111100',
].join(' ')

// rationals, complex numbers and decimals, through the same words, the generic task over rationals, and the name a
// rational had before (`plus`), kept one release
const OTHERS = `load @term/base/rational
  find rational
  find make-rational
  find rational-text
  find plus

load @term/base/complex
  find complex
  find make-complex

load @term/base/decimal
  find big-decimal
  find make-big-decimal

load @term/base/arithmetic
  find addition

task total
  head t, need addition
  take a, like t
  take b, like t
  like t
  back add(a, b)

task run
  like text
  save half, make-rational(1, 2)
  save third, make-rational(1, 3)
  save z, multiply(make-complex(1.0, 2.0), make-complex(3.0, 4.0))
  save money, add(make-big-decimal(<0.1>), make-big-decimal(<0.2>))
  save cost, multiply(make-big-decimal(<1.5>), make-big-decimal(<2.25>))
  back <{rational-text(add(half, third))} {rational-text(subtract(half, third))} {rational-text(multiply(half, third))} {rational-text(divide(half, third))} {rational-text(negate(half))} {rational-text(total(half, third))} {rational-text(plus(half, third))} {z/real} {z/imaginary} {money/text()} {cost/text()}>
`

const OTHERS_EXPECTED = '5/6 1/6 1/6 3/2 -1/2 5/6 5/6 -5 10 0.3 3.375'

// a raise through a mask's task, inside a task bounded by the mask, caught by its caller: dividing a rational by zero
// raises `defect`, and every backend must hand it to the guard, never end the program
const RAISE = `load @term/base/rational
  find rational
  find make-rational
  find rational-text

load @term/base/arithmetic
  find division

task ratio
  head t, need division
  take a, like t
  take b, like t
  like t
  back divide(a, b)

task run
  like text
  mark unsafe
    save never, ratio(make-rational(1, 2), make-rational(0, 3))
    back rational-text(never)
  halt take
    take problem
    back <caught>
`

const dir = mkdtempSync(join(tmpdir(), 'term-arithmetic-masks-'))
const only = process.env.MASK_ONLY ?? ''

for (const backend of BACKENDS.filter(b => !only || b === only)) {
  const said = (program: string, name: string) => runOn({ backend, program, resolve: env => projectResolver(process.cwd(), env), dir, name })
  const shown = (ran: ReturnType<typeof said>): string =>
    ran.form === 'ran' ? `got ${JSON.stringify(ran.output)}` : ran.form === 'skipped' ? ran.reason : `${ran.stage}: ${ran.reason}`

  const money = said(MONEY, 'money')

  if (money.form === 'skipped') {
    console.log(`skip  ${backend}: ${money.reason}`)
    continue
  }

  ok(`${backend}: a form wearing addition is added directly and by a bounded task`, money.form === 'ran' && money.output === '7 7 7', shown(money))

  const big = said(BIG, 'big')
  ok(`${backend}: big integers take add, subtract, multiply and divide, and the bounded task`, big.form === 'ran' && big.output === BIG_EXPECTED, shown(big))

  // a float prints its own way on each backend (`-5.0` on Kotlin and Swift), so the two parts are read as numbers
  const others = said(OTHERS, 'others')
  const normal = others.form === 'ran' ? others.output.replace(/(-?\d+)\.0\b/g, '$1') : ''
  ok(`${backend}: rationals, complex numbers and decimals take the same words, and plus still answers`, normal === OTHERS_EXPECTED, shown(others))

  const raised = said(RAISE, 'raise')
  ok(`${backend}: a raise through a mask in a bounded task reaches the caller's guard`, raised.form === 'ran' && raised.output === 'caught', shown(raised))
}

if (!only || only === 'typescript') {
  // a form that wears no arithmetic mask is refused as before, naming the number it is not
  const refused = compile(
    { file: join(dir, 'refused.tree'), text: 'form point\n  link x, like number\n\ntask run\n  like point\n  save p, make point, bind x, 1\n  back add(p, p)\n' },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  ok('a form that wears no mask is not added', !refused.ok && refused.diagnostics.some(d => d.message.includes('expected number')), refused.ok ? 'it built' : refused.diagnostics.map(d => d.message).join(' | '))

  // `like self` is the wearer: a task taking another form where the mask says self is refused
  const mismatch = compile(
    {
      file: join(dir, 'self.tree'),
      text: 'load @term/base/arithmetic\n  find addition\n\nform money\n  link cents, like number\n  wear addition\n    task add\n      take self\n      take other, like number\n      like money\n      back self\n',
    },
    { resolve: projectResolver(process.cwd(), 'node'), env: 'node' },
  )
  ok('a worn task must take the wearer where the mask says like self', !mismatch.ok && mismatch.diagnostics.some(d => d.message.includes('wears "addition"')), mismatch.ok ? 'it built' : mismatch.diagnostics.map(d => d.message).join(' | '))
}

console.log(`\narithmetic-masks: ${pass} pass, ${fail} fail`)

if (fail > 0) {
  process.exit(1)
}
