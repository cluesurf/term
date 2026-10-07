/**
 * The synthesis loop architecture: the GapReport (the one interface
 * between "found a hole" and "fill it"), the Proposer interface (every
 * fix source implements it), and the driver that tries proposers and
 * re-verifies. This is Phases A-C of the synthesis design
 * (note/project/term/verification/synthesis.md).
 *
 * The driver, the proof and both proposers' answers are Term since
 * 2026-10-04, deck/test/code/repair-loop.tree. This is the face: a
 * proposer here answers a candidate or `null`, as its callers write one
 * (ai-proposer, contract, the demos), and is wrapped into Term's, whose
 * answer is a `maybe`.
 */

import { cegisPropose, hintPropose, repair as repairAll, showRepair, specHolds } from '@term/test/code/repair-loop'
import type { GapReport as Report, Proposer as TermProposer, RepairResult } from '@term/test/code/repair-loop'
import type { Expression } from '@term/test/code/expression-grammar'
import type { Spec } from './synthesize'

/**
 * A structured description of a verification hole. The single value
 * every proposer consumes.
 */
export type GapReport = {
  /** Human- and AI-readable statement of what is missing. */
  goal: string
  /** Number of integer inputs the missing code takes. */
  varCount: number
  /** What "correct" means: does this output satisfy the spec? */
  spec: Spec
  /** Concrete inputs known to break a wrong candidate. Grows as the loop refines. */
  counterexamples: number[][]
  /** The domain over which the driver proves a candidate correct. */
  bound: number
}

/** A proposed fix. Here, an expression to use as the function body. */
export type Candidate = Expression

/**
 * A fix source. Given the gap (including every counterexample so far),
 * return a candidate or null ("I have nothing for this").
 */
export type Proposer = {
  name: string
  propose: (gap: GapReport) => Candidate | null
}

export type { RepairResult }
export { showRepair }

// the port's spec is a `specification`, a task or a contract as data (2026-10-05): a TypeScript spec goes in as the
// task, and a port gap comes back out with a spec that reads the specification, whichever it is
export function toTermGap(gap: GapReport): Report {
  return { ...gap, spec: { form: 'direct', check: gap.spec } } as unknown as Report
}

export function fromTermGap(gap: Report): GapReport {
  return { ...(gap as unknown as GapReport), spec: (inputs, output) => specHolds(gap.spec, inputs, output) }
}

function toTerm(proposer: Proposer): TermProposer {
  return {
    name: proposer.name,
    propose: gap => {
      const found = proposer.propose(fromTermGap(gap))

      return found ? { form: 'some', value: found } : { form: 'none' }
    },
  }
}

export { toTerm as termProposer }

/**
 * The loop. Each round, try the proposers in order until one yields a
 * candidate consistent with every counterexample, then PROVE it over the
 * bound. If proven, done. If a counterexample falls out, add it to the
 * gap and go again.
 */
export function repair(gap: GapReport, proposers: Proposer[], options: { maxRounds?: number } = {}): RepairResult {
  return repairAll(toTermGap(gap), proposers.map(toTerm), options.maxRounds ?? 64)
}

/**
 * The CEGIS proposer: the smallest grammar expression consistent with
 * every counterexample so far.
 */
export function cegisProposer(maxSize = 6): Proposer {
  return {
    name: 'cegis',
    propose(gap) {
      const found = cegisPropose(maxSize, toTermGap(gap))

      return found.form === 'some' ? found.value : null
    },
  }
}

/**
 * The plug point for an AI proposer: a table of hinted bodies keyed by
 * the gap's goal. It defers (null) when it has no hint, so CEGIS takes
 * over.
 */
export function hintProposer(hints: Record<string, Expression>): Proposer {
  const table = new Map(Object.entries(hints))

  return {
    name: 'ai-hint',
    propose(gap) {
      const found = hintPropose(table, toTermGap(gap))

      return found.form === 'some' ? found.value : null
    },
  }
}
