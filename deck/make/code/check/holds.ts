// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in refine.ts. An unprovable hold is a
// diagnostic. See note/research/vibe/computation/plans/04-typecheck.md. Browser-safe.
//
// The checker is Term (self-hosting, 2026-10-06), in parts: check/nonlinear.tree (the polynomial core),
// check/universal.tree (recurrences, universal hypotheses, induction), check/inequality.tree (the linear translation and
// the goals), and check/hold-facts.tree, hold-reach.tree, hold-loops.tree and hold-walk.tree (the walk). Their tables
// are ONE `hold-state` (check/hold-state.tree), built here. This face keeps what the Term parts hand back to TypeScript:
// the memoized linear prover (check/refine.ts), the product prover under its budget (check/product.ts), the widths
// (check/width-range.ts), the program's sets cached per program (check/facts.ts), the profile and the replay counter,
// and the caller's `Tally`, converted both ways.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import type { Expression, HoldOrigin, Program } from '@term/make/code/compile/node'
import {
  functionNames,
  lengthKeepingFunctions,
  pureFunctions,
  returnsFreshFunctions,
  stateFreeFunctions,
} from '@term/make/code/check/facts'
import { atLeast, atMost, linear, noteUncertified, proves, uncertifiedCount } from '@term/make/code/check/refine'
import { unfoldDefinitions } from '@term/make/code/check/unfold'
import type { Fact } from '@term/make/code/check/product'
import { budgetSpent, openBudget, productProfile, productProves, workSpent } from '@term/make/code/check/product'
import { freshHoldState } from '@term/make/code/check/hold-state'
import type { HoldState } from '@term/make/code/check/hold-state'
import * as universalPart from '@term/make/code/check/universal'
import * as inequalityPart from '@term/make/code/check/inequality'
import * as holdWalk from '@term/make/code/check/hold-walk'
import { WIDTHS, widthRanges } from '@term/make/code/check/width-range'

// THE PROVER'S TABLES ARE ONE `hold-state` (check/hold-state.tree), built once and read by every Term part. The atoms
// and the linear translation's counters are never cleared, as they never were
const STATE: HoldState = freshHoldState()

// a width-typed parameter's range as facts: each bound a number holds exactly (inside 2^53), so `u64` keeps its 0 and
// `i64` says nothing a number does not
function widthFacts(name: string, width: string | undefined): ReturnType<typeof atLeast>[] {
  const range = width ? WIDTHS[width] : undefined

  if (!range) {
    return []
  }

  const exact = (value: bigint): boolean => value <= 2n ** 53n - 1n && value >= -(2n ** 53n - 1n)
  const [low, high] = range
  const self = linear({ [name]: 1 })

  return [
    ...(exact(low) ? [atLeast(self, linear({}, Number(low)))] : []),
    ...(exact(high) ? [atMost(self, linear({}, Number(high)))] : []),
  ]
}

// each width-typed field, `<form>/<field>` to its width: a form's own fields under the form's name, a case's under the
// case's, which is the name a construction of it carries. Two definitions that give one key different widths leave it
// the empty text, which says nothing, the rule check/contracts.tree `note-width` keeps on the owing side
function fieldWidthsOf(program: Program): Map<string, string> {
  const table = new Map<string, string>()
  const note = (key: string, width: string | undefined): void => {
    if (width === undefined || !(width in WIDTHS)) {
      return
    }

    table.set(key, table.has(key) && table.get(key) !== width ? '' : width)
  }

  for (const s of program) {
    if (s.form !== 'record-type') {
      continue
    }

    for (const field of s.fields) {
      note(`${s.name}/${field.name}`, field.width)
    }

    for (const variant of s.variants) {
      for (const field of variant.fields) {
        note(`${variant.name}/${field.name}`, field.width)
      }
    }
  }

  return table
}

// `TERM_PRODUCT_PROFILE=1`: each theorem goal prints its time and its share of the product search (product.ts)
const PROFILE_GOALS = typeof process !== 'undefined' && Boolean(process.env?.TERM_PRODUCT_PROFILE)

// THE PROOF BUDGET: the exact search's work one goal may spend, in product.ts's units (rows times the pivot row's bits,
// THE BUDGET). Set from the library: the costliest proof measured on 2026-10-05 is in
// note/term/handoff-math-and-proof.md, and this is far above it, so it costs no proof there and stops a refusal where
// one used to search for half an hour. `TERM_PROOF_BUDGET=<units>` changes it for one run (`Infinity` removes it)
const PROOF_BUDGET_UNITS = 1e10

// read per goal, so a run (or a test) may set it between compiles
function proofBudget(): number {
  return Number((typeof process !== 'undefined' && process.env?.TERM_PROOF_BUDGET) || PROOF_BUDGET_UNITS)
}

// a port polynomial (big-integer rationals) in check/product.ts's shape
const productPolynomial = (p: Map<string, { n: { dock: unknown }; d: { dock: unknown } }>): Fact['polynomial'] =>
  new Map([...p].map(([key, r]) => [key, { n: r.n.dock as bigint, d: r.d.dock as bigint }]))

// what the Term parts ask TypeScript
const CALLS: universalPart.HoldCalls = {
  toLinear: (expr, side) => inequalityPart.toLinear(STATE, CALLS, expr as never, side),
  assumptionInequalities: (expr, negated, side) => inequalityPart.assumptionInequalities(STATE, CALLS, expr as never, negated, side),
  polynomialFacts: (cond, negated) => inequalityPart.polynomialFacts(STATE, cond as never, negated),
  productGoalLinear: (expr, facts) => inequalityPart.productGoalLinear(STATE, CALLS, expr as never, facts),
  productGoal: (expr, facts) => inequalityPart.productGoal(STATE, CALLS, expr as never, facts),
  refutedByProducts: facts => inequalityPart.refutedByProducts(CALLS, facts),
  proves: (facts, goal) => proves(facts, goal),
  theoremParts: rule => inequalityPart.theoremParts(rule as never) as never,
  unfold: expr => unfoldDefinitions(expr as never, STATE.program as never) as never,
  productProves: (facts, goal, strict, multipliers) =>
    productProves(
      facts.map(f => ({ polynomial: productPolynomial(f.polynomial as never), relation: f.relation as Fact['relation'] })),
      productPolynomial(goal as never),
      strict,
      multipliers.form === 'some' ? { multipliers: multipliers.value } : undefined,
    ),
  noteUncertified: () => noteUncertified(),
  widthFacts: (name, width) => widthFacts(name, width),
}

// how many tasks' walks were answered from the memo, for the step's test (test/check/hold-memo.ts)
export const holdsReplayed = { tasks: 0 }

const WALK_CALLS: holdWalk.WalkCalls = {
  proofBudget: () => proofBudget(),
  openBudget: units => openBudget(units),
  budgetSpent: () => budgetSpent(),
  widthRanges: () => widthRanges(),
  fieldWidths: program => fieldWidthsOf(program as never),
  uncertifiedCount: () => uncertifiedCount(),
  replayed: () => {
    holdsReplayed.tasks++
  },
  profileBegin: () => (PROFILE_GOALS ? { at: Date.now(), ...productProfile } : undefined),
  profileEnd: (began: (typeof productProfile & { at: number }) | undefined, name, verdict) => {
    if (!began) {
      return
    }

    const spent = (key: keyof typeof productProfile): number => productProfile[key] - began[key]

    console.error(
      `profile ${name}: ${verdict} in ${Date.now() - began.at} ms, ${spent('refutes')} searches, ` +
        `${spent('rows')} rows, ${spent('cells')} cells, ${spent('floatDeclined')} declined in floating point, ` +
        `${spent('exactPivots')} exact pivots, ${spent('exactWork')} work, ${workSpent()} spent, build ${spent('buildMs')} ms, exact ${spent('exactMs')} ms`,
    )
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

// the rules this pass has proven so far, and how: the measurement behind "every certificate holds over any ordered
// field", which is true of a rule marked `field` and not known of one marked `integer`
// Not the rules the kernel proved, which this pass only knows of (`kernelOnly`): a stub records how its unit's provers
// proved a rule, and a dependent reads a carried rule with no such record as the kernel's (compile/stub.ts)
export function provenRules(): ReadonlyMap<string, 'field' | 'integer'> {
  return new Map(
    [...(STATE.provenTheorems as Map<string, 'field' | 'integer'>)].filter(([name]) => !STATE.kernelOnly.has(name)),
  )
}

const flags = (names: Iterable<string>): Map<string, boolean> => new Map([...names].map(name => [name, true]))

// the caller's tally as the walk's, and the walk's written back: `seen` and `kinds` exist once something was counted
function tallyIn(tally: Tally): holdWalk.HoldTally {
  return {
    total: tally.total,
    proven: tally.proven,
    failed: tally.failed as never,
    hasSeen: tally.seen !== undefined,
    seen: tally.seen ?? new Map(),
    hasKinds: tally.kinds !== undefined,
    kinds: new Map(Object.entries(tally.kinds ?? {})) as never,
  }
}

function tallyOut(from: holdWalk.HoldTally, tally: Tally): void {
  tally.total = from.total
  tally.proven = from.proven

  if (from.hasSeen) {
    tally.seen = from.seen
  }

  if (from.hasKinds) {
    const kinds = tally.kinds ?? {}

    for (const [kind, count] of from.kinds) {
      kinds[kind as Tier0] = count
    }

    tally.kinds = kinds
  }
}

// THE PROVERS' TABLES OF ONE PROGRAM LIVE ONLY WHILE ITS HOLDS ARE CHECKED. The pure tasks, the recurrences, the aliases
// and the program itself decide what an atom is, and the kernel asks `isLinearGoal` before this pass runs: left set,
// they answered the next program's kernel with the last program's tasks, so a goal's verdict depended on what had been
// built before it in the same process (a false set law was accepted after a true one, test/check/truth-table.ts)
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
  } = {},
): Diagnostic[] {
  const tally = options.tally ? tallyIn(options.tally) : undefined

  try {
    const diagnostics = holdWalk.checkProgramHolds(STATE as never, CALLS as never, WALK_CALLS, {
      program: program as never,
      file,
      originOnly: options.originOnly === true,
      tally: tally ? { form: 'some', value: tally } : { form: 'none' },
      limited: options.only !== undefined,
      only: flags(options.only ?? []),
      skip: flags(options.skip ?? []),
      pure: flags(options.pure ?? pureFunctions(program)),
      stateFree: flags(options.stateFree ?? stateFreeFunctions(program)),
      keeping: flags(options.keeping ?? lengthKeepingFunctions(program)),
      returning: flags(options.returning ?? returnsFreshFunctions(program)),
      functions: flags(functionNames(program)),
      kernelProven: [...(options.kernelProven ?? [])],
    })

    return diagnostics as never
  } finally {
    if (tally && options.tally) {
      tallyOut(tally, options.tally)
    }

    STATE.program = []
    STATE.resultWidths = new Map()
    STATE.fieldWidths = new Map()
    STATE.pureTasks = new Map()
    STATE.recurrences = new Map()
    STATE.aliases = new Map()
    STATE.integerTasks = new Map()
    STATE.integerNames = new Map()
  }
}

// forget every kept walk, so a test can ask the provers afresh
export function clearHoldMemo(): void {
  STATE.memo.clear()
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
  kinds?: Partial<Record<Tier0, { total: number; proven: number }>>
}

// the obligations nobody wrote, which the gate counts rather than fails
export type Tier0 = 'index' | 'zero' | 'ends' | 'width'

// tier-0 obligations summed over files, as a build reports them
export type Owed = { total: number; proven: number; kinds?: Tally['kinds'] }

// what each kind of tier-0 obligation is, as the build line names it
const OWED_KINDS: [Tier0, string][] = [
  ['index', 'list reads in bounds'],
  ['zero', 'divisions by something other than zero'],
  ['ends', 'walks shown to end'],
  ['width', 'values inside their width'],
]

// add one file's obligations into a running total
export function addOwed(into: Owed, from: Owed | undefined): void {
  if (!from) {
    return
  }

  into.total += from.total
  into.proven += from.proven

  for (const [kind] of OWED_KINDS) {
    const add = from.kinds?.[kind]

    if (add) {
      const sum = ((into.kinds ??= {})[kind] ??= { total: 0, proven: 0 })
      sum.total += add.total
      sum.proven += add.proven
    }
  }
}

// `12 of 12 list reads in bounds, 2 of 3 walks shown to end`: each kind that was owed, with its denominator
export function describeOwed(owed: Owed): string {
  return OWED_KINDS.flatMap(([kind, what]) => {
    const one = owed.kinds?.[kind]

    return one && one.total > 0 ? [`${one.proven} of ${one.total} ${what}`] : []
  }).join(', ')
}
