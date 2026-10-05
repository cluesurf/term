/**
 * Counterexample-Guided Inductive Synthesis (CEGIS): synthesize a
 * function body from a specification, automatically, by letting the
 * verifier hand back counterexamples that carve away the wrong-program
 * space until a correct program remains.
 *
 * This is Level 3 of the synthesis design (note/methodology/
 * verification/synthesis.md), and the runnable proof that "the verifier
 * figures out what code to add" is real: you give it the spec (what
 * correct means) and a grammar (the shape of allowed code), and it
 * returns a program the verifier accepts.
 *
 * The grammar is a small integer-expression language over named inputs,
 * Term since 2026-10-04 (deck/test/code/expression-grammar.tree). The
 * verifier is the property engine in ./property. The loop is the classic
 * CEGIS skeleton, deterministic throughout.
 */

import { check, genInt, genTuple, type Gen } from './property'
import { enumerate, evalExpr, showExpr } from '@term/test/code/expression-grammar'
import type { Condition, Expression } from '@term/test/code/expression-grammar'

// the grammar's names, as this module's callers (variant, predicate, smt, model) import them
export type Expr = Expression
export type Cond = Condition
export { enumerate, evalExpr, showExpr }

// --- the specification + the CEGIS loop ---

/** A spec: given the inputs and the candidate's output, is it correct? */
export type Spec = (inputs: number[], output: number) => boolean

export type SynthResult =
  | {
      ok: true
      expr: Expr
      counterexamples: number[][]
      candidatesTried: number
    }
  | { ok: false; reason: string; counterexamples: number[][] }

/**
 * Synthesize an expression over `varCount` integer inputs satisfying
 * `spec`. The loop:
 *   1. find the smallest candidate consistent with all counterexamples
 *   2. verify it with the property engine
 *   3. if the verifier finds a new counterexample, add it and repeat
 * Each counterexample removes a slice of wrong programs, so the loop
 * converges. Deterministic.
 */
export function synthesize(input: {
  varCount: number
  spec: Spec
  maxSize?: number
  inputGen?: Gen<number[]>
}): SynthResult {
  const { varCount, spec } = input
  const maxSize = input.maxSize ?? 6
  const inputGen =
    input.inputGen ??
    (genTuple(...Array.from({ length: varCount }, () => genInt)) as Gen<number[]>)

  const candidates = enumerate(maxSize, varCount)
  const counterexamples: number[][] = []
  let candidatesTried = 0

  // bound the outer loop by the number of candidates (it cannot need
  // more refinements than there are programs)
  for (let round = 0; round <= candidates.length; round++) {
    // the smallest candidate consistent with every counterexample so far
    const pick = candidates.find(expr => {
      candidatesTried++
      return counterexamples.every(ce => spec(ce, evalExpr(expr, ce)))
    })

    if (!pick) {
      return {
        ok: false,
        reason: 'no expression in the grammar satisfies the constraints',
        counterexamples,
      }
    }

    // verify the pick against random inputs; the verifier is the oracle
    const result = check(
      inputGen,
      ce => spec(ce, evalExpr(pick, ce)),
      { runs: 500, seed: 7 },
    )

    if (result.ok) {
      return { ok: true, expr: pick, counterexamples, candidatesTried }
    }

    // the verifier found a hole: add it and refine
    counterexamples.push(result.counterexample)
  }

  return {
    ok: false,
    reason: 'did not converge within the candidate budget',
    counterexamples,
  }
}
