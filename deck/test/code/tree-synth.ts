/**
 * Structural recursion over a RECURSIVE algebraic data type: synthesize
 * a catamorphism (a fold) over a binary tree, as a LEAF handler over the
 * leaf's payload and a NODE combiner over the two recursive results.
 *
 * Term since 2026-10-05 (deck/test/code/tree-synthesis.tree, paired against
 * this file's original over 40 specs by tmp/pair-tree.ts). This is its face:
 * the TypeScript callers keep their names and the union result.
 */

import { cata as fold, synthesizeTree as search } from '@term/test/code/tree-synthesis'
import { showExpr, type Expr } from './synthesize'

/** A binary tree: a recursive ADT. */
export type Tree =
  | { kind: 'leaf'; value: number }
  | { kind: 'node'; left: Tree; right: Tree }

/** The catamorphism: fold a tree to a number via the two handlers. */
export function cata(tree: Tree, leaf: Expr, node: Expr): number {
  return fold(tree as never, leaf, node)
}

export type TreeSynthResult =
  | { ok: true; leaf: Expr; node: Expr; counterexamples: number }
  | { ok: false; reason: string }

/** Synthesize a tree catamorphism matching `spec` (a reference fold) for all trees. */
export function synthesizeTree(input: {
  spec: (tree: Tree) => number
  maxSize?: number
  seed?: number
}): TreeSynthResult {
  const found = search(input.spec as never, input.maxSize ?? 3, input.seed ?? 1) as {
    ok: boolean
    leaf: Expr
    node: Expr
    counterexamples: number
    reason: string
  }

  return found.ok
    ? { ok: true, leaf: found.leaf, node: found.node, counterexamples: found.counterexamples }
    : { ok: false, reason: found.reason }
}

export { showExpr }
