// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in check/eliminate.tree. An unprovable hold is
// a diagnostic. See note/project/term/archive/computation/plans/04-typecheck.md. Browser-safe.
//
// The checker is Term (self-hosting, 2026-10-06), in parts: check/nonlinear.tree (the polynomial core),
// check/universal.tree (recurrences, universal hypotheses, induction), check/inequality.tree (the linear translation, the
// goals and the widths' facts), and check/hold-facts.tree, hold-reach.tree, hold-loops.tree and hold-walk.tree (the
// walk). Their tables are ONE `hold-state` (check/hold-state.tree), held here. The provers' records are the instances
// check/refine.ts and check/product.ts hold, carried on the one `hold-calls` that inequality.tree builds (item 0356,
// decision 057 rule 5). A build's owed sums are check/holding.tree, and the caller's `Tally` is hold-reach.tree's
// `hold-tally` itself.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Expression, HoldOrigin, Program } from '@term/make/code/compile/node'
import { functionNames, programFacts } from '@term/make/code/check/facts'
import type { ProgramFacts } from '@term/make/code/check/program-facts'
import { refineState } from '@term/make/code/check/refine'
import { productProfile, productWork } from '@term/make/code/check/product'
import { clearHoldMemo as clearHoldMemoIn, freshHoldState, provenRules as provenRulesIn } from '@term/make/code/check/hold-state'
import type { HoldState } from '@term/make/code/check/hold-state'
import { checkerSwitches } from '@term/make/code/check/strict'
import * as inequalityPart from '@term/make/code/check/inequality'
import * as holdWalk from '@term/make/code/check/hold-walk'
import type { Owed, OwedKinds } from '@term/make/code/check/holding'
import { addOwed as addOwedIn, describeOwed } from '@term/make/code/check/holding'

export type { Owed } from '@term/make/code/check/holding'
export { describeOwed }

// THE PROVER'S TABLES ARE ONE `hold-state` (check/hold-state.tree), built once and read by every Term part. The atoms
// and the linear translation's counters are never cleared, as they never were
const STATE: HoldState = freshHoldState()

// and its calls: the provers' records, one instance each, and the inequality tasks universal.tree calls back
const CALLS = inequalityPart.holdCallsOver(refineState, productWork, productProfile)

// how many tasks' walks were answered from the memo, for the step's test (test/check/hold-memo.ts): hold-state's count
export const holdsReplayed = {
  get tasks(): number {
    return STATE.holdsReplayed
  },
}

// whether a hold's goal lies in the decidable fragment the provers here own: the kernel proof layer (elaborate) skips
// these, so the linear prover is the single authority for arithmetic (check/inequality.tree)
export function isLinearGoal(expr: Expression): boolean {
  return inequalityPart.isLinearGoal(STATE, CALLS, expr as never)
}

// AN ORDER FROM FACTS, for the kernel closing an induction case over its own atoms (check/elaborate.ts `orderCase`)
export function orderFollows(goal: Expression, facts: Expression[]): boolean {
  return inequalityPart.orderFollows(STATE, CALLS, goal as never, facts as never)
}

// the rules this pass has proven so far, and how, without the ones only the kernel proved (hold-state.tree)
export function provenRules(): ReadonlyMap<string, 'field' | 'integer'> {
  return provenRulesIn(STATE) as ReadonlyMap<string, 'field' | 'integer'>
}

const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))

// every `hold` of the program checked, the program's tables forgotten before and after (check/hold-walk.tree
// `check-holds`)
export function checkHolds(
  program: Program,
  file: string,
  options: {
    originOnly?: boolean
    tally?: Tally
    only?: Set<string>
    // tasks NOT to walk here, because another pass checks them (compile.ts: the file's own tasks, in the copy)
    skip?: Set<string>
    // the pure tasks, when the caller already knows them (the checker's copy has the real program's answer)
    pure?: Set<string>
    // and the state-free ones, likewise
    stateFree?: Set<string>
    // and the length-keeping ones, and the ones that hand back a list they made
    keeping?: Set<string>
    returning?: Set<string>
    // the rules the kernel proved (compile/compile.ts `provenByKernel`): a `cite` may rest on them. Read as proven with
    // integer reasoning, which claims the least
    kernelProven?: Set<string>
    // the program's facts, when the caller made them (compile/program-proofs.tree, item 0368): the four above are read
    // off them, each one the caller did not hand in
    facts?: ProgramFacts
  } = {},
): Diagnostic[] {
  // the facts once, and only when one of them is not handed in
  const handed = options.pure && options.stateFree && options.keeping && options.returning
  const known = options.facts ?? (handed ? undefined : programFacts(program))

  return holdWalk.checkHolds(STATE as never, CALLS as never, {
    program: program as never,
    file,
    originOnly: options.originOnly === true,
    tally: options.tally ? { form: 'some', value: options.tally as never } : { form: 'none' },
    limited: options.only !== undefined,
    only: flags(options.only ?? []),
    skip: flags(options.skip ?? []),
    pure: flags(options.pure ?? known!.pure),
    stateFree: flags(options.stateFree ?? known!.stateFree),
    keeping: flags(options.keeping ?? known!.lengthKeeping),
    returning: flags(options.returning ?? known!.returnsFresh),
    functions: flags(functionNames(program)),
    kernelProven: [...(options.kernelProven ?? [])],
    switches: checkerSwitches,
  }) as never
}

// forget every kept walk, so a test can ask the provers afresh
export function clearHoldMemo(): void {
  clearHoldMemoIn(STATE)
}

// the tier-0 count for one compile: how many obligations, how many proven, and the ones that were not, each with
// the task it is in and what it was owed for, which is how a baseline names it without a line number
export type Tally = {
  total: number
  proven: number
  // `ordinal` counts EVERY obligation of that kind in that task, proven or not, in the order they are met. A count
  // of failures alone renumbered every later one when an earlier one became proven, and a baseline keyed on it
  // churned with no change to the code it named.
  failed: {
    task: string
    origin: HoldOrigin
    ordinal: number
    diagnostic: Diagnostic
  }[]
  // the running count per `<task> <kind>`, for the ordinal
  seen?: Map<string, number>
  // the same counts per kind, so a build line can say what was owed. One `tier 0` line counted a walk's termination
  // under "list reads in bounds, no division by zero" (guides: language/notes, 2026-10-04)
  kinds?: OwedKinds
}

// the obligations nobody wrote, which the gate counts rather than fails
export type Tier0 = keyof OwedKinds

// add one file's obligations into a running total (check/holding.tree)
export function addOwed(into: Owed, from: Owed | undefined): void {
  if (from) {
    addOwedIn(into, from)
  }
}
