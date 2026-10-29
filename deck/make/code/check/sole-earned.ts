// THE SOLE DECLARATION IS EARNED (term/affine-kinds-0008, decision note/project/term/affine-kinds/decision/
// 001-many-by-default-sole-and-hide-declared-per-form.md, section earned).
//
// The check is Term, check/sole-holding.tree, and its header says what it refuses and why (item
// term-self-host-change-001-finish-self-host-0002). compile/program-types.tree docks this face, which keeps the
// TypeScript name its callers know.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { checkSoleEarned as earnedIn } from '@term/make/code/check/sole-holding'

// every form that holds a sole value in a field, directly or through other forms, and does not say `mark sole`
export function checkSoleEarned(
  program: Program,
  file: string,
): Diagnostic[] {
  return earnedIn(program as never, file) as Diagnostic[]
}
