// Memory profiling. Runs the compiled program once in a child `node --expose-gc`, each `time-*` task once, a collection
// forced before and after, so the heap delta is what the program kept. The work is Term, time/memory-profiling.tree
// (item term-self-host-change-001-finish-self-host-0011), whose header says what changed; the result and its report
// are time/profile.tree. This face keeps the names and the object input its callers know, and throws `CompileFailure`
// for a file that does not compile.
import type { Resolver } from '@term/make/code/compile/load'
import { CompileFailure } from '@term/make/code/time/execute'
import {
  formatBytes,
  formatMemoryResult,
} from '@term/make/code/time/profile'
import type { MemoryResult } from '@term/make/code/time/profile'
import * as profiling from '@term/make/code/time/memory-profiling'

export { formatBytes, formatMemoryResult }
export type { MemoryResult }

export async function runMemoryProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
}): Promise<MemoryResult> {
  const made = await profiling.runMemoryProfile(
    input.text,
    input.file,
    input.resolve,
    input.root,
    input.name,
  )

  if (!made.ok) {
    throw new CompileFailure(made.diagnostics as never)
  }

  return (made.result as { value: MemoryResult }).value
}
