// What can be refused about a `twin` without running anything (note/term/optimize/admission.md, optimize-0006). The
// checks are Term, check/admission.tree (self-hosting, 2026-10-06), and its header says what each asks. This face hands
// them the linear prover and the test of an arm's written `binds`, which the termination analysis they run takes from
// TypeScript (check/totality.ts).

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Program, Twin } from '@term/make/code/compile/node'
import { checkTwins as checkTwinsIn, easeWords, isTestTwin, twinTaskName } from '@term/make/code/check/admission'
import { proves } from '@term/make/code/check/refine'
import { bindsGiven } from '@term/make/code/check/totality'

// a twin declared under its package's test/: admitted by its signature alone (mocks spec 2.1)
// a twin declared under its package's test/: admitted by its signature alone (mocks spec 2.1)
export { isTestTwin, twinTaskName }

// the relaxations Term defines, each with its decision procedure in note/term/optimize/words.md
export const EASE = new Set(easeWords())

export function checkTwins(program: Program, twins: Twin[], file: string): Diagnostic[] {
  return checkTwinsIn(program, twins, file, proves, bindsGiven)
}
