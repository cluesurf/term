/**
 * Synthesis over structured outputs and recursion. Run:
 *   npx tsx deck/test/code/demo-ir-synth.ts
 *
 *   A. tuple output: minmax(a, b) -> (min, max) and swap(a, b) -> (b, a),
 *      each component synthesized from its own spec.
 *   B. recursion via fold: sum and length over a list, synthesized as a
 *      fold step from input/output behavior alone. The fold is the
 *      recursion; CEGIS finds the step.
 *
 * A step from the scalar grammar toward the full Seed IR. Deterministic.
 */

import { synthesizeTuple, synthesizeFold, runFold, showExpr } from './ir-synth'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

// ============================================================
// A. tuple / record output
// ============================================================
console.log('--- A. structured (tuple) output ---')

// minmax(a, b) -> (min, max)
const minmax = synthesizeTuple({
  varCount: 2,
  specs: [
    ([a, b], out) => out <= a && out <= b && (out === a || out === b), // min
    ([a, b], out) => out >= a && out >= b && (out === a || out === b), // max
  ],
})
ok('synthesized minmax(a,b) -> (min, max)', minmax.ok,
  minmax.ok ? `=> (${minmax.exprs.map(e => showExpr(e, ['a', 'b'])).join(', ')})` : minmax.reason)

// swap(a, b) -> (b, a)
const swap = synthesizeTuple({
  varCount: 2,
  specs: [
    ([a, b], out) => out === b,
    ([a, b], out) => out === a,
  ],
})
ok('synthesized swap(a,b) -> (b, a)', swap.ok,
  swap.ok ? `=> (${swap.exprs.map(e => showExpr(e, ['a', 'b'])).join(', ')})` : swap.reason)

// ============================================================
// B. recursion via fold
// ============================================================
console.log('\n--- B. recursive list functions (fold) ---')

// sum: init 0, step should be acc + elem
const sum = synthesizeFold({ init: 0, spec: list => list.reduce((a, e) => a + e, 0) })
ok('synthesized sum as a fold', sum.ok,
  sum.ok ? `=> fold(0, step=${showExpr(sum.step, ['acc', 'elem'])}) (${sum.counterexamples.length} counterexamples)` : sum.reason)
if (sum.ok) {
  ok('synthesized sum is correct on [3,4,5]', runFold(sum.step, sum.init, [3, 4, 5]) === 12)
}

// length: init 0, step should be acc + 1
const length = synthesizeFold({ init: 0, spec: list => list.length })
ok('synthesized length as a fold', length.ok,
  length.ok ? `=> fold(0, step=${showExpr(length.step, ['acc', 'elem'])})` : length.reason)

// running-max-with-floor: init 0, step = max(acc, elem) (clamped at 0)
const runMax = synthesizeFold({ init: 0, spec: list => list.reduce((a, e) => Math.max(a, e), 0) })
ok('synthesized running-max as a fold', runMax.ok,
  runMax.ok ? `=> fold(0, step=${showExpr(runMax.step, ['acc', 'elem'])})` : runMax.reason)

console.log(`\nseed-verify ir-synth demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
