/**
 * Synthesizing boolean predicates - synthesis beyond integer
 * arithmetic. Run:
 *   npx tsx deck/test/code/demo-predicate.ts
 *
 * From a boolean spec alone, the synthesizer derives a predicate
 * (comparisons + and/or/not), proven over the bounded domain. This
 * generalizes the grammar from integer-valued bodies toward the full
 * Seed IR.
 */

import { synthesizePred, showPred, type PredSpec } from './predicate'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// in-range(x, lo, hi) := lo <= x <= hi
const inRange: PredSpec = ([x, lo, hi], out) => out === (x >= lo && x <= hi)
const r1 = synthesizePred({ varCount: 3, spec: inRange })
ok('synthesized in-range(x, lo, hi)', r1.ok,
  r1.ok ? `=> ${showPred(r1.pred, ['x', 'lo', 'hi'])} (${r1.counterexamples.length} counterexamples)` : r1.reason)

// is-nonneg(x) := x >= 0
const isNonneg: PredSpec = ([x], out) => out === (x >= 0)
const r2 = synthesizePred({ varCount: 1, spec: isNonneg })
ok('synthesized is-nonneg(x)', r2.ok,
  r2.ok ? `=> ${showPred(r2.pred, ['x'])}` : r2.reason)

// ordered(a, b) := a <= b
const ordered: PredSpec = ([a, b], out) => out === (a <= b)
const r3 = synthesizePred({ varCount: 2, spec: ordered })
ok('synthesized ordered(a, b)', r3.ok,
  r3.ok ? `=> ${showPred(r3.pred, ['a', 'b'])}` : r3.reason)

// outside(x, lo, hi) := NOT in range -> exercises `not` over `and`
const outside: PredSpec = ([x, lo, hi], out) => out === !(x >= lo && x <= hi)
const r4 = synthesizePred({ varCount: 3, spec: outside, predSize: 4 })
ok('synthesized outside(x, lo, hi) (uses not/or)', r4.ok,
  r4.ok ? `=> ${showPred(r4.pred, ['x', 'lo', 'hi'])}` : r4.reason)

console.log(`\nseed-verify predicate demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
