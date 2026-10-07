// The coverage pass (term/decisions-2026-10/coverage, spec.md §3): a `probe` before every executable statement of the
// files a test run is measured over, keyed `<path relative to root>:<line>`. The pass is Term, ir/cover.tree, and its
// header says what it covers and when it runs. This face keeps the TypeScript shape of its target and writes the program
// the pass answers back into the one the caller handed, as ir/twin.ts does.

import type { Program } from '@term/make/code/compile/node'
// the port of ir/cover.tree, named by its file: this face is `cover.ts` beside it, so the usual `@term/make/code/ir/cover`
// would reach the face itself (a same-name pair, ../../note/project/term/decisions-2026-10/traps.md T002)
import { coverProgram as coverProgramIn } from '@term/make/host/port/code/ir/cover'

// what a cover pass measures: a file is covered when it is `prefix` or is under it, and a key's path is relative to `root`
export type CoverTarget = { prefix: string; root: string }

// probes written into the program, and every key one was written for, in the order written
export function coverProgram(program: Program, target: CoverTarget): string[] {
  const answer = coverProgramIn(program, target)

  if (answer.program !== program) {
    program.splice(0, program.length, ...answer.program)
  }

  return answer.keys
}
