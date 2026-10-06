// The first IR transformation pass: a mid-level simplifier over the compile AST. Constant folding and algebraic
// identities, so the emitted code is leaner. The pass is Term, ir/simplifying.tree (self-hosting, 2026-10-06), and its
// header says what it does and in what order. This face answers what Term cannot ask: whether a `let` is a host global,
// its `foreign` set, since an absent text and an empty one read alike in Term. Pure and browser-safe.

import type { Program, Statement } from '@term/make/code/compile/node'
import { simplify as simplifyIn } from '@term/make/code/ir/simplifying'

const foreign = (statement: Statement): boolean => statement.form === 'let' && statement.foreign !== undefined

// run the simplifier over a whole program: collapse pass-through wrappers, drop unused host globals, fold constants and
// identities, specialize constant-selector verbs to their native branch, and drop the verbs that fully unwrapped away.
// `roots` are the entry module's public functions, kept even when nothing calls them
export function simplify(program: Program, roots?: Set<string>): Program {
  return simplifyIn(program, roots ? { form: 'some', value: [...roots] } : { form: 'none' }, foreign)
}
