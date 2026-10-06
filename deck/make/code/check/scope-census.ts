// THE SCOPE CENSUS (module-scope-0001). A Term name is meant to belong to the module that defines it and to reach
// another module only through `load ... / find`. The compiler merges every module into one flat program instead, so
// this counts, over a milled program and the import scope `collectModules` recorded, what that merge is relied on for:
//
//   collisions    a name defined in two or more files, in one namespace. Today their definitions merge: two tasks of
//                 different signatures become global overloads, two forms corrupt each other
//   unimported    a reference whose file neither defines the name nor imports a file that does (by `find`, or through
//                 that file's `bear` chain), so only the global merge resolves it
//
// Two namespaces, because a task and a form of one name are two things told apart by position:
//
//   value   tasks (not form methods), components (`view`), top-level `host` constants, dock aliases, binds. Referenced
//           by a variable: a call's callee, a task passed as a value, a component placed in a view
//   type    forms, masks, opaque dock types. Referenced by a named type (a `like`), a `make`, a `halt <form>`, a mask
//           instance, a method's form
//
// A name nothing in the program defines (an intrinsic like `add`, a local, a typo) is not counted: the census is about
// the merge, not about unknown names. Pure: reads the program, changes nothing.
//
// The census is Term, check/census.tree (self-hosting, 2026-10-06). This face hands it the import scope as the list
// the ported passes take, and a missing `skip` as a test that skips nothing.

import type { Program } from '@term/make/code/compile/node'
import { scopeList, type ImportScope } from '@term/make/code/compile/load'
import { censusOf } from '@term/make/code/check/census'

export type Namespace = 'value' | 'type'

export type Collision = { namespace: Namespace; name: string; files: string[] }

export type Unimported = { namespace: Namespace; name: string; file: string; definers: string[] }

// `shadowed`: an unimported reference whose name is ALSO a method of some form in the program, so it is most likely a
// receiver call (`call size, read items` dispatches to the list's own `size`), which needs no import, and which a
// top-level task of the same name from a module the file never imported can capture (native-dom-0036). Counted apart
// from `unimported`, because the fix is resolution by position (module-scope-0005), not a `find`.
export type ScopeCensus = { collisions: Collision[]; unimported: Unimported[]; shadowed: Unimported[] }

export function scopeCensus(program: Program, scope: ImportScope, skip?: (file: string) => boolean): ScopeCensus {
  return censusOf(program as never, scopeList(scope) as never, skip ?? (() => false)) as ScopeCensus
}
