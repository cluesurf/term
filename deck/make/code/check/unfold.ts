// Definitional unfolding for the ring prover: each call to a non-recursive single-expression task replaced by its body,
// the arguments substituted for the parameters. The pass is Term, check/unfolding.tree (self-hosting, 2026-10-06), and
// its header says what is unfolded and why it is sound. This face keeps the table of the LAST program asked about,
// module state: one slot answers the whole hit pattern, because the prover unfolds many goals against one program before
// it moves on, and holds at most one program alive.

import type { Expression, Program } from '@term/make/code/compile/node'
import {
  substitute as substituteIn,
  unfoldDefinitions as unfoldIn,
  unfoldTable,
} from '@term/make/code/check/unfolding'

// substitute each parameter by its argument, simultaneously (an argument is never re-substituted). Also how the kernel
// instantiates a universal hypothesis at a goal's terms (check/elaborate.ts universalInstances)
export function substitute(e: Expression, binding: Map<string, Expression>): Expression {
  return substituteIn(e, binding)
}

let last: { program: Program; table: ReturnType<typeof unfoldTable> } | undefined

// unfold every call to a non-recursive single-expression task, innermost arguments first
export function unfoldDefinitions(e: Expression, program: Program): Expression {
  if (last?.program !== program) {
    last = { program, table: unfoldTable(program) }
  }

  return unfoldIn(e, last.table)
}
