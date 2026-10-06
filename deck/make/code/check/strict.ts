// THE TWO INFERENCE REFUSALS THAT WAIT ON A DECISION (note/term/plan/decisions-2026-10.md, D10). Each refuses code that
// builds today, so each is built behind this switch, off until the decision, and on for a census with
// TERM_INFER_STRICT=1 (`pnpm term:inference-census`), exactly as the gradual seam waits behind TERM_UNKNOWN_SEAM:
//
//   unconstrained-parameter  a parameter no call and no use gives a type. It is a free variable to the end, spelled
//                            `number` on TypeScript and a type parameter on Rust, so one task means two things
//   ambiguous-call           a call that several same-arity definitions fit equally. The last definition wins in
//                            silence, so which one runs depends on the order the build merged the modules in
//
// Its own module, so the switch is module state the checker reads and a test can set. The gradual seam's switch lives
// here too (check/seam.tree holds the seam itself, and Term holds no module state).

import { widthRanges } from '@term/make/code/check/width-range'

let on = process.env.TERM_INFER_STRICT === '1'

// THE GRADUAL SEAM'S SWITCH: whether an `unknown` must be narrowed before it flows into a typed place (check/seam.tree).
// Off until the decision (note/term/plan/decisions-2026-10.md, D1), on for a census with TERM_UNKNOWN_SEAM=1
let seam = process.env.TERM_UNKNOWN_SEAM === '1'

export function setUnknownSeam(value: boolean): void {
  seam = value
}

// whether the seam is on: part of every compile cache key, since it decides what the checker refuses
export function unknownSeamOn(): boolean {
  return seam
}

export function setInferStrict(strict: boolean): void {
  on = strict
}

export function inferStrict(): boolean {
  return on
}

// THE CHECKER'S SWITCHES AS ONE KEY PART, for every compile cache: each decides what the checker refuses, so a unit
// checked with one set is never an answer for another. The await switch is on by default and keyed as it always was,
// so a key with the two off is the key before they existed. A switch left out of the key let a census under it read
// answers stored without it, and count less than it should
export function checkerSwitchKey(awaitOutside: boolean, seam: boolean): string {
  return `${awaitOutside ? 'await-outside' : ''}${seam ? '+seam' : ''}${on ? '+strict' : ''}${widthRanges() ? '+widths' : ''}`
}
