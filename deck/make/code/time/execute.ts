// Compiled execution primitives. We never interpret: we compile a `.tree` file to TypeScript, strip the types to an
// ES module, write it to a folder under the project, and run it with `node` in a child process. The work is Term,
// time/execute-steps.tree (item term-self-host-change-001-finish-self-host-0010), whose header says what changed. This
// face keeps the names and shapes its callers know, and the `CompileFailure` class they test with `instanceof`.

import type { Program } from '@term/make/code/compile/node'
import type { Resolver } from '@term/make/code/compile/load'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import * as steps from '@term/make/code/time/execute-steps'

export class CompileFailure extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super('compilation failed')
  }
}

// a compiled module, or the CompileFailure its diagnostics make
export function compiledOrThrown(made: {
  ok: boolean
  code: string
  program: unknown
  diagnostics: unknown[]
}): { code: string; program: Program } {
  if (!made.ok) {
    throw new CompileFailure(made.diagnostics as Diagnostic[])
  }

  return { code: made.code, program: made.program as Program }
}

// Compile a `.tree` file to a runnable TypeScript module plus its checked program (for discovery). The resolver is
// what makes an entry with imports compile the way `term make` compiles it
export function compileToModule(input: {
  text: string
  file: string
  resolve?: Resolver
}): { code: string; program: Program } {
  return compiledOrThrown(
    steps.compileToModule(input.text, input.file, input.resolve),
  )
}

// the emitted TypeScript as an ES module in a fresh folder under the project; the answer is the folder
export function prepareModuleDir(input: {
  root: string
  code: string
  tag: string
}): Promise<string> {
  return steps.prepareModuleDir(input.root, input.code, input.tag)
}

// run an ES module with `node` and answer its stdout. `gc` exposes `global.gc` for memory work
export function runNode(input: {
  file: string
  cwd: string
  gc?: boolean
}): Promise<string> {
  return steps.runNode(input.file, input.cwd, input.gc ?? false)
}

export async function cleanupDir(dir: string): Promise<void> {
  steps.cleanupDir(dir)
}
