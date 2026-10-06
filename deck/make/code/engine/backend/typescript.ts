// The TypeScript backend's in-process runners: the emitted text run with `new Function` against the RT runtime
// (runtime.ts), for validation against the interpreter. The emitter is Term, engine/backend/typescript-text.tree
// (`compileToTypescript` for the standalone module, `compileForRun` and `compileDeclarations` for these two). See
// note/research/vibe/computation/backend/03-backends.md.

import type { Program } from '@term/make/code/engine/ast'
import type { Value } from '@term/make/code/engine/value'
import * as RT from '@term/make/code/engine/backend/runtime'
import {
  compileDeclarations,
  compileForRun,
  typescriptPreamble,
} from '@term/make/code/engine/backend/typescript-text'

// run a compiled program in-process for validation (returns the last expression's value)
export async function runCompiled(program: Program): Promise<Value> {
  const { declarations, body } = compileForRun(program)
  const fn = new Function(
    'RT',
    `return (async () => { ${typescriptPreamble()} ${declarations} ${body} return RT.UNIT_V; })()`,
  )

  return fn(RT) as Promise<Value>
}

// run a named function from a compiled program with argument values, for validation against the interpreter
export async function runCompiledFunction(
  program: Program,
  name: string,
  args: Value[],
): Promise<Value> {
  const fn = new Function(
    'RT',
    '__ARGS__',
    `return (async () => { ${typescriptPreamble()} ${compileDeclarations(program)} return ${name}(...__ARGS__); })()`,
  )

  return fn(RT, args) as Promise<Value>
}
