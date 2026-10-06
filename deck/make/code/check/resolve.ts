// The resolver: bind every name to its definition. Walks the compile AST with a scope stack, attaches a binding
// to each variable, handles forward references to functions, and reports unknown names with a did-you-mean. An
// unresolved name that is not legally runtime-deferred becomes an unknown-name diagnostic. This is the hole-filling
// pass (the part that fills name and import holes). See note/research/vibe/computation/plans/11-elaboration.md.
//
// The resolver is check/resolving.tree (self-hosting, 2026-10-06). It writes each binding into the program it is
// handed, as this did, and a variable named `hole` that nothing binds is replaced in its place by a typed hole. This
// face hands it the overload groups, module state of check/overload.ts.

import type { Diagnostic, Span } from '@term/make/code/parser/diagnostic'
import type { Binding, Program } from '@term/make/code/compile/node'
import { overloadGroups } from '@term/make/code/check/overload'
import * as port from '@term/make/code/check/resolving'

export type Scope = Map<string, Binding>

// the name a typed hole is written with (`back hole`, `call add(hole, 1)`): only where nothing of the name is in scope
export const HOLE = 'hole'

// the span of a name written last in an expression's span: a lean `foo` spans the word, a longhand `read foo` the
// whole reference, and the name ends both. A span over several lines is returned whole, and an edit carries the
// text it expects to replace, so a span that is not the name is refused when applied rather than written over
export function nameSpan(span: Span, name: string): Span {
  return port.nameSpan(span, name)
}

// build the global scope: top-level functions (+ form method bare-names), native aliases, and the intrinsics. Pure
// over the program, so the incremental compiler builds it once and reuses it to resolve each definition in isolation.
// See note/seed/plan/functional-checker.md (Tier 2, stage 1).
export function buildGlobalScope(program: Program): Scope {
  return port.buildGlobalScope(program as never, overloadGroups) as Scope
}

export function resolve(
  program: Program,
  file: string,
  // incremental hooks (default = whole-program, unchanged): `scope` reuses a prebuilt global scope instead of building
  // one; `only` resolves just that one function. The per-definition path passes both. See functional-checker.md.
  options?: { scope?: Scope; only?: string },
): Diagnostic[] {
  return port.resolveProgram(
    program as never,
    file,
    overloadGroups,
    options?.scope ? { form: 'some', value: options.scope as never } : { form: 'none' },
    options?.only !== undefined ? { form: 'some', value: options.only } : { form: 'none' },
  )
}
