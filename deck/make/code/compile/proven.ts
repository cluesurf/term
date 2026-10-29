// The integer operations the TypeScript emitter writes unchecked: a counted loop's step and the other shapes
// ir/facts/steps.tree proves, and every `+`, `-` and `*` the interval fact bounds inside the safe integers.
//
// THE FACE (item term-self-host-001-0354, decision 056): the answer is compile/ts-program.tree's own, `proven-rows`,
// the rows the emitter reads, over the program stamped as the emitter stamps it (decision 011). A node is asked by its
// place-row, so a caller visits the stamped program this answers. Before: tmp/retired/make/compile/proven-face.ts.
import type {
  Expression,
  Statement,
} from '@term/make/code/compile/node'
import { provenRows } from '@term/make/code/compile/ts-program'

export type Proven = {
  program: Statement[]
  has(node: Expression): boolean
}

export function provenArithmetic(program: Statement[]): Proven {
  const answer = provenRows(program as never) as unknown as {
    program: Statement[]
    rows: Map<number, boolean>
  }

  return {
    program: answer.program,
    has: node =>
      answer.rows.has((node as { placeRow?: number }).placeRow ?? 0),
  }
}
