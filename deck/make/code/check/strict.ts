// THE TWO INFERENCE REFUSALS THAT WAIT ON A DECISION (note/project/term/decisions-2026-10/decisions-2026-10.md, D10). Each refuses code that
// builds today, so each is built behind this switch, off until the decision, and on for a census with
// TERM_INFER_STRICT=1 (`pnpm term:inference-census`), exactly as the gradual seam waits behind TERM_UNKNOWN_SEAM:
//
//   unconstrained-parameter  a parameter no call and no use gives a type. It is a free variable to the end, spelled
//                            `number` on TypeScript and a type parameter on Rust, so one task means two things
//   ambiguous-call           a call that several same-arity definitions fit equally. The last definition wins in
//                            silence, so which one runs depends on the order the build merged the modules in
//
// DECIDED 2026-10-07 (D10, ambiguous-only): the ambiguous-call refusal is ON BY DEFAULT, its own switch, since no call
// in the repository is ambiguous; TERM_INFER_AMBIGUOUS=0 turns it off. The unconstrained-parameter refusal stays behind
// TERM_INFER_STRICT until its census (face 315, base 8, site 2) reaches zero. TERM_INFER_STRICT=1 still turns both on.
//
// A face over check/checker-switches.tree (item term-self-host-001-0261, spec.md 4.8): every checker switch is one
// field of one `checker-switches` record, and this module holds the one instance a process has until the compile
// driver is Term and makes it per run. check/width-range.ts and compile/compile.ts (the await switch) read and set
// their switches on the same instance, and each reader's own port takes the record as a parameter.

import {
  refusesAmbiguous,
  switchesFromEnv,
  switchKey,
} from '@term/make/code/check/checker-switches'
import type { CheckerSwitches } from '@term/make/code/check/checker-switches'

// the process's switches, read from its environment once, at load, as each module-level switch was
export const checkerSwitches: CheckerSwitches = switchesFromEnv()

// check/substitution.tree reads the width switch from here (a Term module cannot import a face), when it makes a
// substitution, so it is written where the instance is made, as check/width-range.ts wrote it whenever this module
// loaded it, and again by every `setWidthRanges`. It goes when substitution.tree's `width-switch` bind reads the
// record (item 0248)
;(globalThis as { termWidthRanges?: boolean }).termWidthRanges = checkerSwitches.widths

export function setAmbiguousRefused(value: boolean): void {
  checkerSwitches.ambiguous = value
}

// whether a call several same-arity definitions fit equally is refused: on by default, or under the strict switch
export function ambiguousRefused(): boolean {
  return refusesAmbiguous(checkerSwitches)
}

// THE GRADUAL SEAM'S SWITCH: whether an `unknown` must be narrowed before it flows into a typed place (check/seam.tree).
// Off until the decision (note/project/term/decisions-2026-10/decisions-2026-10.md, D1), on for a census with
// TERM_UNKNOWN_SEAM=1. The flip to on by default (seam-0008, `!== '0'`, TERM_UNKNOWN_SEAM=0 the off switch) was built
// and reverted on 2026-10-23: the full gate with it on failed 24 suites the node-only census never built (browser,
// webview and checker programs, seam log 2026-10-23). test/check/seam-default.ts holds the flip once it is made
export function setUnknownSeam(value: boolean): void {
  checkerSwitches.seam = value
}

// whether the seam is on: part of every compile cache key, since it decides what the checker refuses
export function unknownSeamOn(): boolean {
  return checkerSwitches.seam
}

export function setInferStrict(strict: boolean): void {
  checkerSwitches.strict = strict
}

export function inferStrict(): boolean {
  return checkerSwitches.strict
}

// THE CHECKER'S SWITCHES AS ONE KEY PART, for every compile cache (checker-switches.tree `switch-key`). The await
// switch and the seam are handed in, as they always were; the rest are the instance's
export function checkerSwitchKey(awaitOutside: boolean, seam: boolean): string {
  return switchKey({ ...checkerSwitches, awaitOutside, seam })
}
