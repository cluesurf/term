// UNFORGEABLE. `mark hide` on a form: only the file that declares it may make one (term/affine-kinds-0009, decision
// note/project/term/affine-kinds/decision/001-many-by-default-sole-and-hide-declared-per-form.md, section hide).
//
// The check is Term, check/hide-guard.tree, and its header says what it refuses and why (item
// term-self-host-change-001-finish-self-host-0001). compile/program-types.tree docks this face, which keeps the
// TypeScript name its callers know.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { DeckHome } from '@term/make/code/check/private'
import { checkHiddenMakes as checkIn } from '@term/make/code/check/hide-guard'

// every make of a hidden form from outside its declaring file, in program order
export function checkHiddenMakes(program: Program, file: string, decks: DeckHome[]): Diagnostic[] {
  return checkIn(program as never, file, decks) as Diagnostic[]
}
