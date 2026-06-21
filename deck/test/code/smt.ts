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
 * A reusable solver session: ONE Z3 solver and ONE set of variable
 * constants, shared across many obligations. Each `prove` runs inside a
 * push/pop scope, so assertions from one obligation are discarded before
 * the next while the solver keeps its learned clauses and the context
 * stays warm. This is the incremental-solving performance key: a CEGIS
 * loop that proves dozens of candidates reuses the solver instead of
 * constructing a fresh one (and re-parsing the variables) every round.
 */
export type SmtSession = {
  z3: Z3
  vars: Z3[]
  // prove that `expr`'s value satisfies `spec` for all integers
  prove(expr: Expr, spec: SymSpec): Promise<SmtResult>
  // forget all learned clauses (rarely needed; push/pop already isolates)
  reset(): void
}

/** Open a solver session over `arity` shared integer variables. */
export function openSmtSession(input: { z3: Z3; arity: number }): SmtSession {
  const { z3, arity } = input
  const vars: Z3[] = Array.from({ length: arity }, (_, i) => z3.Int.const(`x${i}`))
  const solver = new z3.Solver()

  return {
    z3,
    vars,
    async prove(expr, spec) {
      const out = exprToZ3(expr, vars, z3)
      solver.push() // scope this obligation's assertion
      solver.add(z3.Not(spec(vars, out, z3)))
      const status = await solver.check()

      let result: SmtResult
      if (status === 'unsat') {
        result = { proven: true }
      } else if (status === 'sat') {
        const model = solver.model()
        // model completion (the `true`) assigns don't-care vars, so the
        // counterexample is fully numeric.
        result = { proven: false, counterexample: vars.map(v => z3Num(model.eval(v, true))) }
      } else {
        result = { proven: false, unknown: true }
      }

      solver.pop() // discard this obligation, keep the solver warm
      return result
    },
    reset() {
      solver.reset()
    },
  }
}

/**
 * Prove that `expr` satisfies `spec` for ALL integers (unbounded), by
 * asking Z3 whether the negation is satisfiable. unsat = proof; sat =
 * the input where it breaks. A one-shot convenience over `openSmtSession`.
 */
export async function proveExpr(input: {
  arity: number
  expr: Expr
  spec: SymSpec
  z3: Z3
  session?: SmtSession
}): Promise<SmtResult> {
  const session = input.session ?? openSmtSession({ z3: input.z3, arity: input.arity })
  return session.prove(input.expr, input.spec)
}
