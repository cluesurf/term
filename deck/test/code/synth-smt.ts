/**
 * Z3-backed synthesis: CEGIS where the verifier is the SMT solver, so
 * the synthesized program is proven correct for ALL integers, not just
 * over a bound. This threads Z3 into the synthesis loop - the
 * counterexamples that drive CEGIS now come from real unsatisfiability
 * checks, and the accepted result carries an unbounded proof.
 *
 * The loop is the classic CEGIS skeleton (./synthesize) with one
 * change: each candidate is verified by `proveExpr` (./smt) instead of
 * the bounded prover. A Z3 `sat` hands back a concrete counterexample
 * that refines the search; a Z3 `unsat` is a proof and ends it.
 */

import { enumerate, evalExpr, type Expr, type Spec } from './synthesize'
import { openSmtSession, type SymSpec } from './smt'

export type SmtSynthResult =
  | { ok: true; expr: Expr; counterexamples: number[][]; unbounded: true }
  | { ok: false; reason: string; counterexamples: number[][] }

/**
 * Synthesize an expression proven (over all integers) to satisfy the
 * spec. `jsSpec` is the concrete point-check used to keep candidates
 * consistent with counterexamples; `symSpec` is the Z3 formula used to
 * prove (or refute) a candidate unboundedly. They state the same
 * property two ways - the contract's postcondition.
 */
export async function synthesizeSmt(input: {
  varCount: number
  jsSpec: Spec
  symSpec: SymSpec
  z3: unknown
  maxSize?: number
}): Promise<SmtSynthResult> {
  const { varCount, jsSpec, symSpec, z3 } = input
  const maxSize = input.maxSize ?? 6

  const candidates = enumerate(maxSize, varCount)
  const counterexamples: number[][] = []

  // ONE solver session reused across every CEGIS round (incremental):
  // each candidate is proved in a push/pop scope, the solver stays warm.
  const session = openSmtSession({ z3, arity: varCount })

  for (let round = 0; round <= candidates.length; round++) {
    // smallest candidate consistent with every counterexample so far
    const pick = candidates.find(expr =>
      counterexamples.every(ce => jsSpec(ce, evalExpr(expr, ce))),
    )

    if (!pick) {
      return { ok: false, reason: 'no expression in the grammar satisfies the constraints', counterexamples }
    }

    // VERIFY with Z3: does the spec hold for ALL integers?
    const verdict = await session.prove(pick, symSpec)

    if (verdict.proven) {
      return { ok: true, expr: pick, counterexamples, unbounded: true }
    }

    if ('counterexample' in verdict) {
      counterexamples.push(verdict.counterexample)
      continue
    }

    return { ok: false, reason: 'z3 returned unknown', counterexamples }
  }

  return { ok: false, reason: 'did not converge', counterexamples }
}
