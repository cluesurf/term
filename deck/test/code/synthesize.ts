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
 * loop and the checking it runs are Term since 2026-10-05
 * (deck/test/code/cegis-search.tree, paired against this file's original
 * over 120 specs by tmp/pair-cegis.ts), and this is its face.
 */

import { synthesize as search } from '@term/test/code/cegis-search'
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
 *   2. verify it on 500 random inputs, shrinking a failure
 *   3. if a new counterexample is found, add it and repeat
 * Each counterexample removes a slice of wrong programs, so the loop
 * converges. Deterministic. The port answers one record, made the union
 * here.
 */
export function synthesize(input: { varCount: number; spec: Spec; maxSize?: number }): SynthResult {
  const found = search(input.varCount, input.spec, input.maxSize ?? 6) as {
    ok: boolean
    expr: Expr
    counterexamples: number[][]
    candidatesTried: number
    reason: string
  }

  return found.ok
    ? { ok: true, expr: found.expr, counterexamples: found.counterexamples, candidatesTried: found.candidatesTried }
    : { ok: false, reason: found.reason, counterexamples: found.counterexamples }
}
