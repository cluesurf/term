/**
 * General recursion over a recursive ADT: synthesizing tree
 * catamorphisms. Run:
 *   npx tsx deck/test/code/demo-tree-synth.ts
 *
 * Synthesizes recursive tree functions (sum, size, max-leaf) from
 * behavior alone - the recursion descends both subtrees and combines.
 * This is structural recursion over a genuinely recursive type, the
 * frontier beyond flat-list folds. Deterministic.
 */

import { synthesizeTree, cata, showExpr, type Tree } from './tree-synth'

let pass = 0
let fail = 0
function ok(name: string, cond: boolean, info = ''): void {
  if (cond) { pass++; console.log(`ok    ${name}${info ? '  ' + info : ''}`) }
  else { fail++; console.log(`FAIL  ${name}${info ? '  ' + info : ''}`) }
}

const leaf = (value: number): Tree => ({ kind: 'leaf', value })
const node = (left: Tree, right: Tree): Tree => ({ kind: 'node', left, right })

// reference folds (the specs)
const treeSum = (t: Tree): number => (t.kind === 'leaf' ? t.value : treeSum(t.left) + treeSum(t.right))
const treeSize = (t: Tree): number => (t.kind === 'leaf' ? 1 : treeSize(t.left) + treeSize(t.right))
const treeMax = (t: Tree): number => (t.kind === 'leaf' ? t.value : Math.max(treeMax(t.left), treeMax(t.right)))

// a sample tree to sanity-check the synthesized function
const sample = node(node(leaf(3), leaf(7)), leaf(2))

// --- tree-sum: leaf(v) -> v, node(l, r) -> l + r ---
const sum = synthesizeTree({ spec: treeSum })
ok('synthesized tree-sum (catamorphism)', sum.ok,
  sum.ok ? `=> leaf: ${showExpr(sum.leaf, ['v'])}, node: ${showExpr(sum.node, ['l', 'r'])} (${sum.counterexamples} counterexamples)` : sum.reason)
if (sum.ok) ok('tree-sum correct on the sample (= 12)', cata(sample, sum.leaf, sum.node) === 12)

// --- tree-size: leaf(v) -> 1, node(l, r) -> l + r ---
const size = synthesizeTree({ spec: treeSize })
ok('synthesized tree-size', size.ok,
  size.ok ? `=> leaf: ${showExpr(size.leaf, ['v'])}, node: ${showExpr(size.node, ['l', 'r'])}` : size.reason)
if (size.ok) ok('tree-size correct on the sample (= 3 leaves)', cata(sample, size.leaf, size.node) === 3)

// --- tree-max: leaf(v) -> v, node(l, r) -> max(l, r) ---
const max = synthesizeTree({ spec: treeMax })
ok('synthesized tree-max-leaf', max.ok,
  max.ok ? `=> leaf: ${showExpr(max.leaf, ['v'])}, node: ${showExpr(max.node, ['l', 'r'])}` : max.reason)
if (max.ok) ok('tree-max correct on the sample (= 7)', cata(sample, max.leaf, max.node) === 7)

console.log(`\nseed-verify tree-synth demo: ${pass} pass, ${fail} fail`)
if (fail > 0) process.exit(1)
