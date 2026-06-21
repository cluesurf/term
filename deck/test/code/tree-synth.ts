/**
 * Structural recursion over a RECURSIVE algebraic data type: synthesize
 * a catamorphism (a fold) over a binary tree. This generalizes the
 * flat-list fold (ir-synth.ts) to a genuinely recursive type - the
 * recursion descends into both subtrees and combines the results - and
 * is the essence of general recursion over recursive ADTs.
 *
 * The function is synthesized as two small expressions:
 *   - a LEAF handler `leaf(value)` over the leaf's payload, and
 *   - a NODE combiner `node(leftResult, rightResult)` over the two
 *     recursive results.
 * The catamorphism wires the recursion; CEGIS over random trees
 * synthesizes the two pieces. (e.g. tree-sum, tree-size, tree-max.)
 */

import { enumerate, evalExpr, showExpr, type Expr } from './synthesize'
import { makeRng, type Rng } from './property'

/** A binary tree: a recursive ADT. */
export type Tree =
  | { kind: 'leaf'; value: number }
  | { kind: 'node'; left: Tree; right: Tree }

/** The catamorphism: fold a tree to a number via the two handlers. */
export function cata(tree: Tree, leaf: Expr, node: Expr): number {
  if (tree.kind === 'leaf') return evalExpr(leaf, [tree.value])
  const l = cata(tree.left, leaf, node)
  const r = cata(tree.right, leaf, node)
  return evalExpr(node, [l, r])
}

/** Generate a random tree (deterministic). */
function randomTree(rng: Rng, depth: number): Tree {
  if (depth <= 0 || rng.next() < 0.4) {
    return { kind: 'leaf', value: Math.floor(rng.next() * 12) - 4 }
  }
  return { kind: 'node', left: randomTree(rng, depth - 1), right: randomTree(rng, depth - 1) }
}

export type TreeSynthResult =
  | { ok: true; leaf: Expr; node: Expr; counterexamples: number }
  | { ok: false; reason: string }

/**
 * Synthesize a tree catamorphism matching `spec` (a reference fold) for
 * all trees. CEGIS over trees: a tree where the candidate computes the
 * wrong value is the counterexample that refines the search.
 */
export function synthesizeTree(input: {
  spec: (tree: Tree) => number
  maxSize?: number
  seed?: number
}): TreeSynthResult {
  const { spec } = input
  const maxSize = input.maxSize ?? 3
  const leafCandidates = enumerate(maxSize, 1) // leaf(value)
  const nodeCandidates = enumerate(maxSize, 2) // node(leftResult, rightResult)
  const rng = makeRng(input.seed ?? 1)

  // pre-generate a fixed probe set of trees (the verification suite)
  const probes: Tree[] = []
  for (let i = 0; i < 300; i++) probes.push(randomTree(rng, 4))

  const counterexamples: Tree[] = []

  // CEGIS: search the (leaf, node) pair space, refine on a wrong tree
  for (let round = 0; round <= leafCandidates.length * nodeCandidates.length; round++) {
    let pick: { leaf: Expr; node: Expr } | undefined
    outer: for (const leaf of leafCandidates) {
      for (const node of nodeCandidates) {
        if (counterexamples.every(t => cata(t, leaf, node) === spec(t))) {
          pick = { leaf, node }
          break outer
        }
      }
    }
    if (!pick) return { ok: false, reason: 'no catamorphism fits the examples' }

    const counter = probes.find(t => cata(t, pick!.leaf, pick!.node) !== spec(t))
    if (!counter) return { ok: true, leaf: pick.leaf, node: pick.node, counterexamples: counterexamples.length }
    counterexamples.push(counter)
  }
  return { ok: false, reason: 'did not converge' }
}

export { showExpr }
