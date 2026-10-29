// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. The pass is Term, ir/simplifying.tree (self-hosting, 2026-10-06), and its
// header says what it does and in what order. Whether a `let` is a host global is read in Term too,
// ir/simplifying-program.tree (item term-self-host-001-0086). This face keeps the roots as its callers hold them, a
// `Set`. Pure and browser-safe.

import type { Program } from '@term/make/code/compile/node'
import { simplifyProgram } from '@term/make/code/ir/simplifying-program'

// run the simplifier over a whole program: collapse pass-through wrappers, drop unused host globals, fold constants and
// identities, specialize constant-selector verbs to their native branch, and drop the verbs that fully unwrapped away.
// `roots` are the entry module's public functions, kept even when nothing calls them
export function simplify(
  program: Program,
  roots?: Set<string>,
): Program {
  return simplifyProgram(
    program,
    roots ? { form: 'some', value: [...roots] } : { form: 'none' },
  )
}
