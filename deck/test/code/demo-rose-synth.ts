/**
 * Mutual recursion synthesis over a rose tree. Run:
 *   npx tsx deck/test/code/demo-rose-synth.ts
 *
 * Synthesizes mutually-recursive folds (the tree fold recurses through
 * a fold over its child list): rose-sum and rose-count, from behavior
 * alone. This closes the mutual-recursion case of the recursion
 * frontier. Deterministic.
 */

import { synthesizeRose, foldRose, showExpr, type Rose } from './rose-synth'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const r = (value: number, ...children: Rose[]): Rose => ({ value, children })

// reference folds
const roseSum = (t: Rose): number => t.value + t.children.reduce((a, c) => a + roseSum(c), 0)
const roseCount = (t: Rose): number => 1 + t.children.reduce((a, c) => a + roseCount(c), 0)

// a sample rose tree: 1 -> [2 -> [4], 3]
const sample = r(1, r(2, r(4)), r(3))

const sum = synthesizeRose({ spec: roseSum })
ok('synthesized rose-sum (mutual recursion)', sum.ok,
  sum.ok ? `=> combine(v,agg)=${showExpr(sum.combine, ['v', 'agg'])}, merge(acc,c)=${showExpr(sum.merge, ['acc', 'c'])}, init=${sum.init} (${sum.counterexamples} cex)` : sum.reason)
if (sum.ok) ok('rose-sum correct on the sample (= 10)', foldRose(sample, sum.combine, sum.merge, sum.init) === 10)

const count = synthesizeRose({ spec: roseCount })
ok('synthesized rose-count', count.ok,
  count.ok ? `=> combine(v,agg)=${showExpr(count.combine, ['v', 'agg'])}, merge(acc,c)=${showExpr(count.merge, ['acc', 'c'])}, init=${count.init}` : count.reason)
if (count.ok) ok('rose-count correct on the sample (= 4 nodes)', foldRose(sample, count.combine, count.merge, count.init) === 4)

console.log(`\nseed-verify rose-synth demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
