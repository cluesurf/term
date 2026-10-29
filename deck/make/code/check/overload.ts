// Arity overloading and module scope for tasks: two functions may share a name if they take different numbers of
// parameters, and a task, a component, a `host` value and a native binding two files define are each bound by what the
// referring file imported. The pass is Term, check/disambiguate.tree (self-hosting, 2026-10-05). This face holds the
// one `overload-bound` record the binding leaves (decision 069), and rewrites the program it is handed in place, as
// callers expect.

import type { Program } from '@term/make/code/compile/node'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { scopeList } from '@term/make/code/compile/load'
import type { ImportScope } from '@term/make/code/compile/load'
import * as port from '@term/make/code/check/disambiguate'

// WHAT THE LAST BINDING LEFT, one instance until the driver is Term (decision 069 section 2). `groups`: same-name,
// same-arity overloads, the first candidate's (mangled) name -> every candidate's name, read by the checker, which picks
// the candidate whose parameter types fit the arguments (check/inferring-expressions.tree choose-overload), and by the
// resolver. `runtime`: what each render runtime name the view lowering writes is called once the build has split names
// by file (D020), read by the view lowering (compile.ts, check/views.ts). Read a field when it is read: keepOverloadBound
// replaces both, so a field held across a build is the previous build's
export const overloadBound = port.freshOverloadBound()

// both fields replaced from a binding's answer, in the order it lists them
export function keepOverloadBound(
  groups: { name: string; members: string[] }[],
  runtime: { name: string; bound: string }[],
): void {
  port.keepOverloadBound(overloadBound, groups, runtime)
}

// Returns the references it could not bind. `entry` is the file whose own definitions keep their names when a name is
// split by file, because its roots and its exported API are called by them. `runtime` names the render runtime's tasks
// to bind (compile.ts passes them), and `overloadBound.runtime` holds the answer.
export function disambiguateOverloads(
  program: Program,
  scope?: ImportScope,
  entry?: string,
  runtime: string[] = [],
  // the render runtime's file, from the build's resolver. Empty, the binding finds it by the path ending `/view/render.tree`
  render = '',
): Diagnostic[] {
  const answer = port.disambiguate(program, scopeList(scope), runtime, render, entry ?? '')

  program.splice(0, program.length, ...(answer.program as Program))
  keepOverloadBound(answer.groups, answer.runtime)

  return answer.diagnostics
}
