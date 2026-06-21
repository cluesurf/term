/**
 * Synthesis over sum types (ADTs / tagged unions). Run:
 *   npx tsx deck/test/code/demo-variant.ts
 *
 * Synthesizes a function that dispatches on a variant's tag - one
 * handler per variant, from behavior alone. With record/tuple synthesis
 * (ir-synth.ts), synthesis now covers both products and sums, the two
 * halves of an algebraic data type. Deterministic.
 */

import { synthesizeVariant, runVariant, showVariant, type Variant, type Tagged } from './variant'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// a sum type: a tagged signed number. pos(x) is the value +x, neg(x) is
// the value -x, zero is 0. to-value recovers the signed value, so the
// neg handler must compute 0 - x.
const variants: Variant[] = [
  { tag: 'pos', arity: 1 },
  { tag: 'neg', arity: 1 },
  { tag: 'zero', arity: 0 },
]
const toValue = synthesizeVariant({
  variants,
  spec: (value: Tagged, out) => {
    switch (value.tag) {
      case 'pos': return out === value.payload[0]
      case 'neg': return out === -value.payload[0]
      case 'zero': return out === 0
      default: return false
    }
  },
})
ok('synthesized variant dispatch (to-value)', toValue.ok)
if (toValue.ok) {
  console.log('  dispatch:\n' + showVariant(toValue.handlers, ['x']))
  ok('pos(5) -> 5', runVariant(toValue.handlers, { tag: 'pos', payload: [5] }) === 5)
  ok('neg(5) -> -5', runVariant(toValue.handlers, { tag: 'neg', payload: [5] }) === -5)
  ok('zero -> 0', runVariant(toValue.handlers, { tag: 'zero', payload: [] }) === 0)
}

// another: unwrap-or-default: some(x) -> x, none -> 0
const optionVariants: Variant[] = [
  { tag: 'some', arity: 1 },
  { tag: 'none', arity: 0 },
]
const unwrapOr = synthesizeVariant({
  variants: optionVariants,
  spec: (value: Tagged, out) =>
    value.tag === 'some' ? out === value.payload[0] : out === 0,
})
ok('synthesized unwrap-or-default over an option type', unwrapOr.ok,
  unwrapOr.ok ? '\n' + showVariant(unwrapOr.handlers, ['x']) : '')

console.log(`\nseed-verify variant demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
