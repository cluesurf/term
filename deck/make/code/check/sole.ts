// UNCOPYABLE. A value of a `mark sole` form has one owner: it is used AT MOST ONCE (term-affine-kinds-0001, decision
// note/project/term/affine-kinds/decision/001-many-by-default-sole-and-hide-declared-per-form.md, section sole).
//
// The check is Term, check/sole-spending.tree, and its header says what it refuses and why (item
// term-self-host-change-001-finish-self-host-0002). compile/program-types.tree docks this face, which keeps the
// TypeScript names its callers know.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { checkSoleGenerics as genericsIn, checkSoleUses as usesIn } from '@term/make/code/check/sole-spending'

// every use of a sole value after it was handed on, a capture of one by a closure, and one handed to an `unknown`
export function checkSoleUses(program: Program, file: string): Diagnostic[] {
  return usesIn(program as never, file) as Diagnostic[]
}

// a sole form as a type argument or an element, on a signature or a form's field
export function checkSoleGenerics(program: Program, file: string): Diagnostic[] {
  return genericsIn(program as never, file) as Diagnostic[]
}
