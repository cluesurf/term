// One definition's compile pass: resolve, type-check, and emit a single function against the shared read-only build
// context (the global scope + the bodies-stripped signature context). This is the exact work the per-definition queries
// (`resolvedDef` / `typedDef` / `emitDef`) do, factored into one pure function so the inline path and a worker thread
// run identical logic (DRY) and cannot diverge. Pure and browser-safe. See note/seed/compiler/parallel-worker-pool.md.

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { resolve as resolveNames } from '@cluesurf/make/code/check/resolve'
import type { Scope } from '@cluesurf/make/code/check/resolve'
import { check as inferTypes } from '@cluesurf/make/code/check/infer'
import { emitTypeScript } from '@cluesurf/make/code/compile/typescript'
import type {
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'

type FunctionDef = Extract<Statement, { form: 'function' }>

export interface DefContext {
  // names -> kind/arity + intrinsics, built once over the merged program
  scope: Scope
  // the merged program with every function body stripped to []: signatures + forms, never bodies (the firewall)
  signatureContext: Program
}

export interface DefOutput {
  typed: FunctionDef
  diagnostics: Array<Diagnostic>
  ts: string
}

// resolve + infer + emit one function against the shared context. The function is cloned first, so the input is never
// mutated and the output is a self-contained value (safe to cache or transfer across a worker boundary).
export function processDef(
  source: FunctionDef,
  context: DefContext,
): DefOutput {
  const clone = structuredClone(source)
  const diagnostics: Array<Diagnostic> = []

  // resolve this function's body against the global scope (only this definition, on its clone)
  diagnostics.push(
    ...resolveNames([clone], '<entry>', undefined, {
      scope: context.scope,
      only: source.name,
    }),
  )

  // type-check it against the bodies-stripped context, with its own resolved body swapped in. Even when resolution
  // reported a problem we still infer, so a build collects every diagnostic for the definition at once.
  const program = context.signatureContext.map(statement =>
    statement.form === 'function' && statement.name === source.name
      ? clone
      : statement,
  )
  diagnostics.push(
    ...inferTypes(program, '<entry>', undefined, source.name),
  )

  return { typed: clone, diagnostics, ts: emitTypeScript([clone]) }
}

// the shared context for a whole program: the global scope and the bodies-stripped signature context
export function buildDefContext(
  program: Program,
  buildScope: (program: Program) => Scope,
): DefContext {
  return {
    scope: buildScope(program),
    signatureContext: program.map(statement =>
      statement.form === 'function'
        ? { ...statement, body: [] }
        : statement,
    ),
  }
}
