// The integer operations an emitter may write unchecked, the same on every backend: a counted loop's step and the
// other shapes ir/facts/range.ts proves, and every `+`, `-` and `*` the interval fact bounds inside the safe integers
// (ir/facts/interval.ts), which reads the record lists their records own (`ownedFields`) for what their slots hold
import type { Expression, Program, Statement } from '@term/make/code/compile/node'
import { nativeForms, ownedFields, type Lend } from '@term/make/code/compile/backend'
import { privateForms } from '@term/make/code/compile/place'
import { provenIncrements } from '@term/make/code/ir/facts/range'
import { boundedArithmetic } from '@term/make/code/ir/facts/interval'

export type Proven = { has(node: Expression): boolean }

export function provenArithmetic(program: Statement[], lend: Map<string, Map<number, Lend>>, fresh: Set<string>): Proven {
  const steps = provenIncrements(program as Program)
  const owned = ownedFields(program, fresh, lend, privateForms(program, lend, fresh))
  const bounded = boundedArithmetic(program as Program, owned, lend, nativeForms(program))

  return { has: node => steps.has(node) || bounded.has(node) }
}
