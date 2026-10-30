// CPU profiling. Runs the compiled program's `time-*` tasks in a child node under V8's `--cpu-prof`, then reads the
// `.cpuprofile` it wrote and ranks the hottest functions by self time. The work is Term, time/cpu-profiling.tree (item
// term-self-host-change-001-finish-self-host-0011), whose header says what changed; the attribution and the report are
// time/profile.tree. This face keeps the names, the object input and the defaults its callers know, and throws
// `CompileFailure` for a file that does not compile.
import type { Resolver } from '@term/make/code/compile/load'
import { CompileFailure } from '@term/make/code/time/execute'
import { formatCpuResult } from '@term/make/code/time/profile'
import type { CpuFrame, CpuResult } from '@term/make/code/time/profile'
import * as profiling from '@term/make/code/time/cpu-profiling'

export { formatCpuResult }
export type { CpuFrame, CpuResult }

export async function runCpuProfile(input: {
  text: string
  file: string
  // the project resolver, so an entry with imports compiles the way `term make` compiles it
  resolve?: Resolver
  root: string
  name: string
  top?: number
  // how long, in milliseconds, each `time-*` task is called over and over under the profiler
  spend?: number
}): Promise<CpuResult> {
  const made = await profiling.runCpuProfile(
    input.text,
    input.file,
    input.resolve,
    input.root,
    input.name,
    input.top ?? 15,
    input.spend ?? 500,
  )

  if (!made.ok) {
    throw new CompileFailure(made.diagnostics as never)
  }

  return (made.result as { value: CpuResult }).value
}
