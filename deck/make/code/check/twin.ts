// What can be refused about a `twin` without running anything (note/project/term/optimize/admission.md, optimize-0006). The
// checks are Term, check/admission.tree (self-hosting, 2026-10-06), and its header says what each asks. This face hands
// them the linear prover, check/refine.ts, whose memo and count are module state.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program, Twin } from '@term/make/code/compile/node'
import {
  checkTwins as checkTwinsIn,
  isTestTwin,
  twinTaskName,
} from '@term/make/code/check/admission'
import { proves } from '@term/make/code/check/refine'

// a twin declared under its package's test/: admitted by its signature alone (mocks spec 2.1)
export { isTestTwin, twinTaskName }

export function checkTwins(
  program: Program,
  twins: Twin[],
  file: string,
): Diagnostic[] {
  return checkTwinsIn(program, twins, file, proves)
}
