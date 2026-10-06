// Arity overloading and module scope for tasks: two functions may share a name if they take different numbers of
// parameters, and a task, a component, a `host` value and a native binding two files define are each bound by what the
// referring file imported. The pass is Term, check/disambiguate.tree (self-hosting, 2026-10-05). This face keeps the
// module state the checker reads, `overloadGroups`, and rewrites the program it is handed in place, as callers expect.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { scopeList } from '@term/make/code/compile/load'
import type { ImportScope } from '@term/make/code/compile/load'
import { disambiguate } from '@term/make/code/check/disambiguate'

// same-name, same-arity overloads: the first candidate's (mangled) name -> every candidate's name. Filled here,
// read by the checker, which picks the candidate whose parameter types fit the arguments (check/infer.ts,
// chooseOverload). A call is mangled to the first candidate so the resolver finds a definition; the checker
// re-targets it once the argument types are known.
export const overloadGroups = new Map<string, string[]>()

// Returns the references it could not bind. `entry` is the file whose own definitions keep their names when a name is
// split by file, because its roots and its exported API are called by them.
export function disambiguateOverloads(program: Program, scope?: ImportScope, entry?: string): Diagnostic[] {
  const answer = disambiguate(program, scopeList(scope), entry ?? '')

  program.splice(0, program.length, ...(answer.program as Program))
  overloadGroups.clear()

  for (const group of answer.groups) {
    overloadGroups.set(group.name, group.members)
  }

  return answer.diagnostics
}
