/**
 * The SMT bridge: real, UNBOUNDED proof via Z3, replacing the bounded-
 * exhaustive prover (./prove) for the linear-integer fragment. This is
 * the "dock Z3 for the VCG/SMT bridge" step. It follows the system's
 * one-solver discipline: refinement, contracts, and synthesis all
 * discharge through this single backend.
 *
 * It encodes a synthesized expression and a symbolic specification as
 * Z3 formulas and asks whether the spec can be violated for ANY
 * integers. `unsat` of the negation is a proof for all inputs (not just
 * a bound); `sat` returns the concrete counterexample. Quantifier-free
 * linear integer arithmetic is decidable, so Z3 returns a definite
 * answer.
 *
 * Z3 is loaded lazily and behind a dock, so the rest of the engine does
 * not depend on it. Requires `z3-solver` (in package.json; run
 * `pnpm install`).
 */

import type { Expr, Cond } from './synthesize'

/** A Z3 context (the high-level z3-solver API surface we use). */
type Z3 = any

/** A symbolic spec: build the postcondition formula from the input
 * vars and the output term. e.g. max: And(out>=a, out>=b, Or(out==a, out==b)). */
export type SymSpec = (vars: Z3[], out: Z3, z3: Z3) => Z3

/** Initialize Z3 once. Returns the context used to build formulas. */
export async function makeSmt(): Promise<Z3> {
  const { init } = await import('z3-solver')
  const { Context } = await init()
  return Context('verify')
}

/** Translate a synthesized expression into a Z3 integer term. */
export function exprToZ3(expr: Expr, vars: Z3[], z3: Z3): Z3 {
  switch (expr.form) {
    case 'var':
      return vars[expr.index]
    case 'const':
      return z3.Int.val(expr.value)
    case 'add':
      return exprToZ3(expr.left, vars, z3).add(exprToZ3(expr.right, vars, z3))
    case 'sub':
      return exprToZ3(expr.left, vars, z3).sub(exprToZ3(expr.right, vars, z3))
    case 'max': {
      const l = exprToZ3(expr.left, vars, z3)
      const r = exprToZ3(expr.right, vars, z3)
      return z3.If(l.ge(r), l, r)
    }
    case 'min': {
      const l = exprToZ3(expr.left, vars, z3)
      const r = exprToZ3(expr.right, vars, z3)
      return z3.If(l.le(r), l, r)
    }
    case 'ite':
      return z3.If(
        condToZ3(expr.test, vars, z3),
        exprToZ3(expr.then, vars, z3),
        exprToZ3(expr.else, vars, z3),
      )
  }
}

/** Read a concrete integer out of a Z3 numeral term. Z3 prints
 * negatives in SMT-LIB form `(- 1)`, which `Number` cannot parse, and
 * exposes `.value()` as a bigint on `IntNum`. */
function z3Num(term: Z3): number {
  if (term && typeof term.value === 'function') {
    return Number(term.value())
  }
  const text = String(term)
  const negative = text.match(/^\(-\s*(\d+)\)$/)
  if (negative) return -Number(negative[1])
  return Number(text)
}

function condToZ3(cond: Cond, vars: Z3[], z3: Z3): Z3 {
  const l = exprToZ3(cond.left, vars, z3)
  const r = exprToZ3(cond.right, vars, z3)
  switch (cond.form) {
    case 'ge':
      return l.ge(r)
    case 'gt':
      return l.gt(r)
    case 'eq':
      return l.eq(r)
  }
}

export type SmtResult =
  | { proven: true }
  | { proven: false; counterexample: number[] }
  | { proven: false; unknown: true }

/**
 * Prove that `expr` satisfies `spec` for ALL integers (unbounded), by
 * asking Z3 whether the negation is satisfiable. unsat = proof; sat =
 * the input where it breaks.
 */
export async function proveExpr(input: {
  arity: number
  expr: Expr
  spec: SymSpec
  z3: Z3
}): Promise<SmtResult> {
  const { arity, expr, spec, z3 } = input

  const vars: Z3[] = Array.from({ length: arity }, (_, i) =>
    z3.Int.const(`x${i}`),
  )
  const out = exprToZ3(expr, vars, z3)

  const solver = new z3.Solver()
  solver.add(z3.Not(spec(vars, out, z3)))

  const status = await solver.check()

  if (status === 'unsat') return { proven: true }

  if (status === 'sat') {
    const model = solver.model()
    // model completion (the `true`) assigns concrete values to
    // don't-care variables, so the counterexample is fully numeric.
    const counterexample = vars.map(v => z3Num(model.eval(v, true)))
    return { proven: false, counterexample }
  }

  return { proven: false, unknown: true }
}
