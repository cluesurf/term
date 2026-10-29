// Definitional unfolding for the ring prover: each call to a non-recursive single-expression task replaced by its body,
// the arguments substituted for the parameters. The pass is Term, check/unfolding.tree (self-hosting, 2026-10-06), and
// its header says what is unfolded and why it is sound. The table of the last program asked about, an identity memo, is
// gone (item 0355, decision 057, spec 4.11): `unfold-over` builds the program's table on each call, timed in the item's
// proof.

import type { Expression, Program } from '@term/make/code/compile/node'
import { substitute as substituteIn, unfoldOver } from '@term/make/code/check/unfolding'

// substitute each parameter by its argument, simultaneously (an argument is never re-substituted). Also how the kernel
// instantiates a universal hypothesis at a goal's terms (check/elaborate.ts universalInstances)
export function substitute(e: Expression, binding: Map<string, Expression>): Expression {
  return substituteIn(e, binding)
}

// unfold every call to a non-recursive single-expression task, innermost arguments first
export function unfoldDefinitions(e: Expression, program: Program): Expression {
  return unfoldOver(e, program)
}
