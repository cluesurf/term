// MODULE SCOPE FOR A HAND-BUILT PIPELINE. `compileProgram` binds every name by what its file imported (forms in
// check/scope.ts, tasks in check/overload.ts), keyed on the file each definition came from. A harness that parses and
// mills the modules itself (the native gates, the roundtrip suites) must do the same, or a name two modules define
// merges flat and binds to the wrong one. That happened on 2026-10-04 to `matches` and `escape-pattern`, which
// `regex.tree` and `pattern.tree` both define: node, built by `compile`, was right, and Rust, Swift and Kotlin, built
// by three harnesses that stamped no file and passed no scope, called the other module's task.
//
// So a harness does two things, and these are they:
//
//   stampModule(built.program, unit.file)         for each module, as it is milled
//   bindModules(program, scope, entry)            once, where it would call extendForms
//
// `scope` is what collectModules returned beside the sources. Without one (a single file, no resolver), only the
// arity tells definitions apart, as in `compile`.
//
// The order of the steps and what stops it is Term, check/module-binding.tree (self-hosting, 2026-10-07). This face
// closes each step over the scope and the entry, and writes the bound program back into the one it was handed, as a
// harness reads it there.

import type { Program } from '@term/make/code/compile/node'
import type { ImportScope } from '@term/make/code/compile/load'
import { scopeList } from '@term/make/code/compile/load'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { bindFormsByImport } from '@term/make/code/check/scope'
import { extendForms } from '@term/make/code/check/extend'
import { disambiguateOverloads } from '@term/make/code/check/overload'
import * as binding from '@term/make/code/check/module-binding'

// each top-level definition of one module knows its file: the module scope splits a name by it, and a diagnostic
// names it
export function stampModule(program: Program, file: string): void {
  binding.stampModule(program, file)
}

// the module scope in `compileProgram`'s order: forms split and bound by import, then extended (an exception form
// gets its fields and every raise is filled), then tasks split and bound by import. The first refusal of any step,
// or none
export function bindModules(program: Program, scope: ImportScope | undefined, entry: string): Diagnostic[] {
  const scopes = scopeList(scope)
  const bound = binding.bindModules(
    program,
    current => bindFormsByImport(current, scopes, entry),
    current => extendForms(current, entry, []),
    current => disambiguateOverloads(current, scope, entry),
  )

  // a harness reads the program it handed in, so the bound one is written back into it
  if (bound.program !== program) {
    program.splice(0, program.length, ...bound.program)
  }

  return bound.diagnostics
}
