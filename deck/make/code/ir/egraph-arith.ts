// Bridge the compiler's arithmetic Expression IR through the e-graph optimizer (code/ir/egraph.ts) for the rewrites a
// greedy peephole pass cannot reach: constant reassociation (`(x + 3) + 4` -> `x + 7`, `(x * 2) * 4` -> `x * 8`),
// commutative folding (`(3 + x) + 4` -> `x + 7`), and `x - x` -> 0. Equality saturation considers every rewrite order
// at once, so it finds these regardless of how the constants are scattered.
//
// Only the unambiguously sound integer fragment is bridged: pure `+` / `-` / `*` over plain variables and
// safe-integer literals. Three deliberate exclusions keep it sound:
//   - division is never fed in, because the e-graph's `(a*b)/b -> a` rule is unsound under division-by-zero and
//     overflow (it would turn a trapping program into a non-trapping one);
//   - leaves are only variables and integer literals -- a call / member / float / bigint makes the whole subtree fall
//     back to the greedy result untouched, so no effectful or imprecise value is ever reordered or folded;
//   - a folded constant that leaves the safe-integer range aborts the rewrite, so a rounded (wrong) literal is never
//     emitted.
// The e-graph form is taken only when it is strictly smaller than the original, so an irreducible expression is
// returned byte-for-byte unchanged (no commutative churn).

import type { Expression, BinaryOp } from '@cluesurf/make/code/compile/node'
import type { Span } from '@cluesurf/make/code/parser/diagnostic'
import type { Expr } from '@cluesurf/make/code/ir/egraph'
import { optimize } from '@cluesurf/make/code/ir/egraph'

const ARITH = new Set<BinaryOp>(['+', '-', '*'])

// convert an Expression into the e-graph Expr, recording each variable's original node so it can be restored with its
// span / binding / type intact. Returns undefined the moment the subtree leaves the sound integer fragment.
// a canonical structural key for a pure access path: a variable or a member chain over one (`p.x`, `a.b.c`). Equal
// keys mean the two expressions read the same place, so they share an e-class -- this is what lets `p.x - p.x` cancel.
// Returns undefined for anything containing a call or other effectful / non-path node, so such a value is never used
// as a leaf (never reordered or cancelled).
function pathKey(node: Expression): string | undefined {
  if (node.form === 'variable') {return `v:${node.name}`}

  if (node.form === 'member') {
    const target = pathKey(node.target)

    return target === undefined
      ? undefined
      : `${target}.${node.name}#${node.nick ?? ''}`
  }

  return undefined
}

function toExpr(
  node: Expression,
  leaves: Map<string, Expression>,
): Expr | undefined {
  if (node.form === 'integer') {
    // a bigint or an out-of-safe-range literal would fold wrong in JS-number arithmetic
    if (typeof node.value === 'bigint') {return undefined}

    if (!Number.isSafeInteger(node.value)) {return undefined}

    return { t: 'int', value: node.value }
  }

  if (node.form === 'binary' && ARITH.has(node.op)) {
    const left = toExpr(node.left, leaves)

    if (!left) {return undefined}

    const right = toExpr(node.right, leaves)

    if (!right) {return undefined}

    return { t: 'op', op: node.op, left, right }
  }

  // a pure, integer-typed leaf: a variable or a member chain over one. The integer-type guard keeps it sound -- float
  // arithmetic is non-associative ((f + 0.1) + 0.2 != f + 0.3) and `f - f` is NaN when f is Inf/NaN, so reassociating
  // or cancelling a non-integer leaf is wrong. Bail on float, unknown, dynamic, or a missing type. A call or other
  // effectful node has no path key, so it is never admitted.
  if (node.form === 'variable' || node.form === 'member') {
    if (node.type?.kind !== 'number') {return undefined}

    const key = pathKey(node)

    if (key === undefined) {return undefined}

    if (!leaves.has(key)) {leaves.set(key, node)}

    return { t: 'var', name: key }
  }

  return undefined
}

// rebuild an Expression from the optimized Expr. Returns undefined if a folded constant left the safe-integer range,
// so a rounded literal is never emitted. Every op produced is one of `+` / `-` / `*` (the only ops fed in), all valid
// BinaryOp, so the cast is sound.
function fromExpr(
  expr: Expr,
  leaves: Map<string, Expression>,
  span: Span,
): Expression | undefined {
  switch (expr.t) {
    case 'int':
      if (!Number.isSafeInteger(expr.value)) {return undefined}

      return { form: 'integer', value: expr.value, span }
    case 'var':
      // reuse the exact original node recorded when the leaf was admitted (keeps its binding / type / nick / span).
      // The leaf is pure, so sharing the node is safe. If it is somehow absent, returning undefined bails the rewrite
      // rather than fabricating a wrong node.
      return leaves.get(expr.name)
    case 'op': {
      const left = fromExpr(expr.left, leaves, span)

      if (!left) {return undefined}

      const right = fromExpr(expr.right, leaves, span)

      if (!right) {return undefined}

      return { form: 'binary', op: expr.op as BinaryOp, left, right, span }
    }
  }
}

// node count, to make sure the e-graph form genuinely shrinks the expression before we take it
function size(expr: Expression): number {
  if (expr.form === 'binary') {return 1 + size(expr.left) + size(expr.right)}

  return 1
}

// optimize an arithmetic expression via the e-graph, or return it unchanged when it is outside the sound fragment or
// the e-graph finds nothing smaller.
export function egraphArith(node: Expression): Expression {
  if (node.form !== 'binary' || !ARITH.has(node.op)) {return node}

  const leaves = new Map<string, Expression>()
  const expr = toExpr(node, leaves)

  if (!expr) {return node}

  const rebuilt = fromExpr(optimize(expr), leaves, node.span)

  if (!rebuilt) {return node}

  return size(rebuilt) < size(node) ? rebuilt : node
}
