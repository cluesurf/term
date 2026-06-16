// E-graph optimizer tests: equality saturation finds the cheapest equivalent form. Run: npx tsx test/ir/egraph.ts

import type { Expr } from '@/code/ir/egraph'
import { optimize, showExpr } from '@/code/ir/egraph'

const int = (value: number): Expr => ({ t: 'int', value })
const v = (name: string): Expr => ({ t: 'var', name })
const op = (o: string, left: Expr, right: Expr): Expr => ({ t: 'op', op: o, left, right })

let pass = 0
let fail = 0
function expect(name: string, got: Expr, want: string): void {
  const g = showExpr(got)
  if (g === want) {
    pass++
    console.log(`ok    ${name}  (${g})`)
  } else {
    fail++
    console.log(`FAIL  ${name}  (got ${g}, want ${want})`)
  }
}

function main(): void {
  // identity: a + 0 -> a
  expect('a + 0', optimize(op('+', v('a'), int(0))), 'a')
  // identity via commutativity: 0 + a -> a
  expect('0 + a', optimize(op('+', int(0), v('a'))), 'a')
  // constant folding: 2 + 3 -> 5
  expect('2 + 3', optimize(op('+', int(2), int(3))), '5')
  // nested folding: 6 * 7 + 0 -> 42
  expect('6 * 7 + 0', optimize(op('+', op('*', int(6), int(7)), int(0))), '42')
  // cancellation: (a * 2) / 2 -> a   (a rule no peephole pass would find without the right order)
  expect('(a * 2) / 2', optimize(op('/', op('*', v('a'), int(2)), int(2))), 'a')
  // commutative cancellation: (2 * a) / 2 -> a
  expect('(2 * a) / 2', optimize(op('/', op('*', int(2), v('a')), int(2))), 'a')
  // a * 0 -> 0
  expect('a * 0', optimize(op('*', v('a'), int(0))), '0')
  // mixed: (a + 0) * 1 -> a
  expect('(a + 0) * 1', optimize(op('*', op('+', v('a'), int(0)), int(1))), 'a')

  // guard: a genuinely irreducible expression must be preserved, not corrupted or wrongly collapsed
  expect('a + b preserved', optimize(op('+', v('a'), v('b'))), '(a + b)')
  expect('a - b preserved', optimize(op('-', v('a'), v('b'))), '(a - b)')
  // guard: commutativity must not change a non-commutative subtraction's meaning
  expect('a / b preserved (not a)', optimize(op('/', v('a'), v('b'))), '(a / b)')
  // guard: distinct variables are not conflated
  expect('(a + b) - b stays (not folded to a, no such rule)', optimize(op('-', op('+', v('a'), v('b')), v('b'))), '((a + b) - b)')

  console.log(`\negraph: ${pass} pass, ${fail} fail`)
}

main()
