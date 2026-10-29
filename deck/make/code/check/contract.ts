// Contracts, lowered into `hold`s, in a COPY of the program that only the checker reads. The pass is Term,
// check/contracts.tree (self-hosting, 2026-10-06), and its header says what each contract line becomes. This face holds
// no logic since item 0071: whether a node carries a contract is Term (`has-contracts`), and the width switch is the
// `widths` field of the one `checker-switches` record check/strict.ts holds.

import type { Expression, Program } from '@term/make/code/compile/node'
import { checkerSwitches } from '@term/make/code/check/strict'
import {
  hasContracts as hasContractsIn,
  lowerContracts as lowerContractsIn,
  substitute as substituteIn,
} from '@term/make/code/check/contracts'

// does any task or walk in the program carry a contract (if not, there is nothing to lower and no copy to make)
export function hasContracts(program: Program): boolean {
  return hasContractsIn(program)
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
  const result = lowerContractsIn(program, file, options.tier0 === true, checkerSwitches.widths)

  return { program: result.program, lowered: new Set(result.lowered) }
}
