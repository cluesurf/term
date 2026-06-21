/**
 * The synthesis loop architecture: the GapReport (the one interface
 * between "found a hole" and "fill it"), the Proposer interface (every
 * fix source implements it), and the driver that tries proposers and
 * re-verifies. This is Phases A-C of the synthesis design
 * (note/methodology/verification/synthesis.md).
 *
 * The discipline: a proposer PROPOSES a candidate (CEGIS enumeration,
 * a mechanical fix, or - the plug point - an AI), and the driver
 * CHECKS it by exhaustive proof over the bound (./prove). A wrong
 * proposal is rejected with a fresh counterexample that refines the
 * gap, so the loop converges and never accepts an unverified fix.
 */

import { prove } from './prove'
import {
  enumerate,
  evalExpr,
  showExpr,
  type Expr,
  type Spec,
} from './synthesize'

/**
 * A structured description of a verification hole. The single value
 * every proposer consumes. In the full system the checker emits this
 * for each unproven obligation; here the fields are the synthesis
 * problem plus the counterexamples gathered so far.
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
export type Candidate = Expr

/**
 * A fix source. Given the gap (including every counterexample so far),
 * return a candidate or null ("I have nothing for this"). CEGIS, the
 * mechanical fixer, and the AI all implement this one interface, so
 * the driver does not care which answered.
 */
export type Proposer = {
  name: string
  propose: (gap: GapReport) => Candidate | null
}

export type RepairResult =
  | {
      ok: true
      expr: Expr
      proposer: string
      rounds: number
      counterexamples: number[][]
    }
  | { ok: false; reason: string; counterexamples: number[][] }

/**
 * The loop. Each round, try the proposers in order until one yields a
 * candidate, then PROVE it over the bound. If proven, done. If a
 * counterexample falls out, add it to the gap and go again - the next
 * proposal must satisfy it. Converges because each counterexample
 * removes a slice of the wrong-program space.
 */
export function repair(
  gap: GapReport,
  proposers: Proposer[],
  options: { maxRounds?: number } = {},
): RepairResult {
  const maxRounds = options.maxRounds ?? 64
  const counterexamples = gap.counterexamples.slice()

  for (let round = 0; round < maxRounds; round++) {
    const working: GapReport = { ...gap, counterexamples }

    // Take the first proposer whose candidate is at least consistent
    // with every counterexample so far. A proposer that re-offers a
    // candidate already refuted (a stubborn wrong AI hint) is skipped,
    // so the loop falls through to the next proposer instead of
    // stalling. This is what makes the layered fallback work.
    let candidate: Candidate | null = null
    let who = ''
    for (const proposer of proposers) {
      const proposed = proposer.propose(working)
      if (!proposed) continue
      const consistent = counterexamples.every(ce =>
        gap.spec(ce, evalExpr(proposed, ce)),
      )
      if (!consistent) continue
      candidate = proposed
      who = proposer.name
      break
    }

    if (!candidate) {
      return {
        ok: false,
        reason: 'no proposer produced a usable candidate',
        counterexamples,
      }
    }

    // CHECK: prove the candidate over the whole bounded domain
    const verdict = prove({
      arity: gap.varCount,
      claim: inputs => gap.spec(inputs, evalExpr(candidate as Expr, inputs)),
      bound: gap.bound,
    })

    if (verdict.ok) {
      return { ok: true, expr: candidate, proposer: who, rounds: round + 1, counterexamples }
    }

    // refine: the proposal was wrong on this input. Remember it.
    counterexamples.push(verdict.counterexample)
  }

  return { ok: false, reason: 'did not converge within the round budget', counterexamples }
}

// --- proposers ---

/**
 * The CEGIS proposer: return the smallest grammar expression
 * consistent with every counterexample so far. The driver verifies and
 * feeds back, so this is the inductive-synthesis core, decomposed to
 * fit the proposer interface. Deterministic.
 */
export function cegisProposer(maxSize = 6): Proposer {
  return {
    name: 'cegis',
    propose(gap) {
      const candidates = enumerate(maxSize, gap.varCount)
      return (
        candidates.find(expr =>
          gap.counterexamples.every(ce => gap.spec(ce, evalExpr(expr, ce))),
        ) ?? null
      )
    },
  }
}

/**
 * The plug point for an AI proposer. In the full system this hands the
 * gap report to the model and parses its patch back into a candidate;
 * the SAME driver then proves it, so the AI can never ship an
 * unverified fix. Here it is a deterministic stand-in: a small table of
 * "hinted" bodies keyed by the gap's goal, representing what a model
 * would propose. It defers (null) when it has no hint, so CEGIS takes
 * over - exactly how the layered proposers compose.
 */
export function hintProposer(
  hints: Record<string, Expr>,
): Proposer {
  return {
    name: 'ai-hint',
    propose(gap) {
      return hints[gap.goal] ?? null
    },
  }
}

/** Render a repair outcome for logging. */
export function showRepair(result: RepairResult, names: string[]): string {
  if (!result.ok) return `unsynthesized: ${result.reason}`
  return `${showExpr(result.expr, names)}  [via ${result.proposer}, ${result.rounds} rounds, ${result.counterexamples.length} counterexamples, proven over bound]`
}
