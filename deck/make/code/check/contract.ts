// Contracts, lowered into `hold`s, in a COPY of the program that only the checker reads. The pass is Term,
// check/contracts.tree (self-hosting, 2026-10-06), and its header says what each contract line becomes. This face keeps
// what Term cannot hold: the width switch (module state in check/width-range.ts), and whether a node carries a contract
// at all, which is a field present or absent, and an absent list and an empty one read alike in Term.

import type { Expression, Program } from '@term/make/code/compile/node'
import { widthRanges } from '@term/make/code/check/width-range'
import {
  hasContracts as hasContractsIn,
  lowerContracts as lowerContractsIn,
  substitute as substituteIn,
} from '@term/make/code/check/contracts'

// does any task or walk in the program carry a contract (if not, there is nothing to lower and no copy to make)
export function hasContracts(program: Program): boolean {
  return hasContractsIn(program, node => {
    const record = node as { have?: unknown; must?: unknown; down?: unknown }

    return record.have !== undefined || record.must !== undefined || record.down !== undefined
  })
}

// replace every read of a name by an expression, without entering a closure (whose parameters may shadow it)
export function substitute(expression: Expression, binding: Map<string, Expression>): Expression {
  return substituteIn(expression, binding)
}

// the checker's copy of a program, with every contract lowered into holds, and the tier-0 obligations of the tasks
// that belong to `file` (when `tier0` is set) written in beside them
export function lowerContracts(
  program: Program,
  options: { file?: string; tier0?: boolean } = {},
): { program: Program; lowered: Set<string> } {
  const file = options.file === undefined ? ({ form: 'none' } as const) : ({ form: 'some', value: options.file } as const)
  const result = lowerContractsIn(program, file, options.tier0 === true, widthRanges())

  return { program: result.program, lowered: new Set(result.lowered) }
}
