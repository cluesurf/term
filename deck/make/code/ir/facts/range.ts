// Increments proven not to overflow (note/term/codegen/passes.md, P2, the first fact built). The analysis is Term,
// ir/facts/steps.tree (self-hosting, 2026-10-06), and its header says what is proven and why each rule is sound. This
// face makes the set an emitter asks of by identity, which Term cannot hold: the port answers the proven nodes
// themselves.

import type { Expression, Program } from '@term/make/code/compile/node'
import { provenIncrements as provenNodes } from '@term/make/code/ir/facts/steps'

export function provenIncrements(program: Program): WeakSet<Expression> {
  return new WeakSet<Expression>(provenNodes(program))
}
