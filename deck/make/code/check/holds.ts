// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in refine.ts. An unprovable hold is a
// diagnostic. See note/research/vibe/computation/plans/04-typecheck.md. Browser-safe.

import type { Diagnostic } from '@cluesurf/make/code/parser/diagnostic'
import { diagnose } from '@cluesurf/make/code/parser/diagnostic'
import type {
  Expression,
  Program,
  Statement,
} from '@cluesurf/make/code/compile/node'
import type { Linear } from '@cluesurf/make/code/check/refine'
import {
  above,
  atLeast,
  atMost,
  below,
  linear,
  proves,
} from '@cluesurf/make/code/check/refine'

let modCounter = 0

// translate a compile-AST expression into a linear form, or undefined if it is not linear. Side constraints (for
// `mod`, whose result is known to lie in [0, k-1]) are pushed into `side` and become extra assumptions.
function toLinear(
  expr: Expression,
  side: Inequality[],
): Linear | undefined {
  switch (expr.form) {
    case 'integer':
      return linear({}, Number(expr.value))
    case 'variable':
      return linear({ [expr.name]: 1 })

    case 'binary': {
      const left = toLinear(expr.left, side)
      const right = toLinear(expr.right, side)

      if (!left || !right) {
        return undefined
      }

      if (expr.op === '+') {
        return add(left, right)
      }

      if (expr.op === '-') {
        return add(left, scale(right, -1))
      }

      if (expr.op === '*') {
        const lc = constantOf(left)
        const rc = constantOf(right)

        if (rc !== undefined) {
          return scale(left, rc)
        }

        if (lc !== undefined) {
          return scale(right, lc)
        }

        return undefined // non-linear (variable * variable)
      }

      if (expr.op === '%') {
        // x mod k, for a positive integer constant k, is a fresh variable known to lie in [0, k-1]
        const k = constantOf(right)

        if (k !== undefined && Number.isInteger(k) && k > 0) {
          const m = linear({ [`__mod${modCounter++}`]: 1 })
          side.push(atLeast(m, linear({}, 0))) // m >= 0
          side.push(atMost(m, linear({}, k - 1))) // m <= k-1

          return m
        }

        return undefined
      }

      return undefined
    }

    default:
      return undefined
  }
}

function add(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms)

  for (const [v, c] of b.terms) {
    terms.set(v, (terms.get(v) ?? 0) + c)
  }

  return { terms, constant: a.constant + b.constant }
}

function scale(a: Linear, k: number): Linear {
  const terms = new Map<string, number>()

  for (const [v, c] of a.terms) {
    terms.set(v, c * k)
  }

  return { terms, constant: a.constant * k }
}

// if a linear form is a pure constant (no variables), return it
function constantOf(a: Linear): number | undefined {
  for (const c of a.terms.values()) {
    if (Math.abs(c) > 1e-12) {
      return undefined
    }
  }

  return a.constant
}

type Inequality = ReturnType<typeof atMost>

// a hold goal: the list of inequalities that must ALL hold (an equality goal splits into two), or null if the
// comparison is outside the linear fragment (then it cannot be discharged here). Mod side-constraints go in `side`.
// whether a hold's goal lies in the decidable linear fragment (both sides translate to linear forms). The kernel
// proof layer (elaborate) skips these so the linear prover here is the single authority for arithmetic, which is what
// keeps it from wrongly discharging a value-false claim like `add 3 3 == add 4 4` (the kernel treats number literals
// opaquely, so it cannot tell 6 from 8; the linear prover can).
export function isLinearGoal(expr: Expression): boolean {
  return goalInequalities(expr, []) !== null
}

function goalInequalities(
  expr: Expression,
  side: Inequality[],
): Inequality[] | null {
  if (expr.form !== 'binary') {
    return null
  }

  // a CONJUNCTION goal (`meet and` -> `P && Q`, ∧) holds when both conjuncts hold: gather every inequality from each
  // side, so the prover must discharge them all. Null if either side falls outside the linear fragment.
  if (expr.op === '&&') {
    const leftGoal = goalInequalities(expr.left, side)
    const rightGoal = goalInequalities(expr.right, side)

    if (leftGoal === null || rightGoal === null) {
      return null
    }

    return [...leftGoal, ...rightGoal]
  }

  const left = toLinear(expr.left, side)
  const right = toLinear(expr.right, side)

  if (!left || !right) {
    return null
  }

  switch (expr.op) {
    case '<':
      return [below(left, right)]
    case '<=':
      return [atMost(left, right)]
    case '>':
      return [above(left, right)]
    case '>=':
      return [atLeast(left, right)]
    case '==':
      return [atMost(left, right), atLeast(left, right)] // a == b  is  a <= b and a >= b
    default:
      return null // != is a disequality, and other operators are non-linear: not provable here
  }
}

// decide whether a goal is provable from the assumptions, handling the propositional structure: a DISJUNCTION
// (`meet or` -> P || Q, ∨) is provable when either disjunct is; a conjunction and the comparisons go through
// goalInequalities (which gathers the inequalities that must ALL hold). Returns true (provable), false (in the linear
// fragment but not provable), or null (outside the fragment -> an unchecked hold, not a failure).
function goalProvable(
  expr: Expression,
  available: Inequality[],
): boolean | null {
  if (expr.form === 'binary' && expr.op === '||') {
    const left = goalProvable(expr.left, available)

    if (left === true) {
      return true
    }

    const right = goalProvable(expr.right, available)

    if (right === true) {
      return true
    }

    // a disjunctive TAUTOLOGY (excluded middle / trichotomy): P || Q holds whenever assuming NOT P proves Q (or
    // assuming NOT Q proves P), since then one side must hold for every value. This is the sound case-split, done by
    // the linear prover: negate one disjunct, add it as an assumption, and try the other. So `n < 0 or n >= 0` proves
    // because not(n < 0) is n >= 0, which is exactly the right disjunct.
    const notLeft = assumptionInequalities(expr.left, true, [])

    if (
      notLeft.length > 0 &&
      goalProvable(expr.right, [...available, ...notLeft]) === true
    ) {
      return true
    }

    const notRight = assumptionInequalities(expr.right, true, [])

    if (
      notRight.length > 0 &&
      goalProvable(expr.left, [...available, ...notRight]) === true
    ) {
      return true
    }

    // both outside the fragment -> outside; otherwise it is in-fragment but unproven
    return left === null && right === null ? null : false
  }

  const side: Inequality[] = []
  const goals = goalInequalities(expr, side)

  if (!goals) {
    return null
  }

  const all = [...available, ...side]

  return goals.every(goal => proves(all, goal))
}

// a condition used as a path assumption: the inequalities it contributes, optionally negated (for an else branch).
// Conjunctions (&&) contribute both sides; anything outside the linear fragment contributes nothing (sound).
function assumptionInequalities(
  expr: Expression,
  negated: boolean,
  side: Inequality[],
): Inequality[] {
  if (expr.form !== 'binary') {
    return []
  }

  if (expr.op === '&&' && !negated) {
    return [
      ...assumptionInequalities(expr.left, false, side),
      ...assumptionInequalities(expr.right, false, side),
    ]
  }

  const left = toLinear(expr.left, side)
  const right = toLinear(expr.right, side)

  if (!left || !right) {
    return []
  }

  // op, then its negation in parentheses
  switch (expr.op) {
    case '<':
      return negated ? [atLeast(left, right)] : [below(left, right)] //  not(a<b) = a>=b
    case '<=':
      return negated ? [above(left, right)] : [atMost(left, right)] //  not(a<=b) = a>b
    case '>':
      return negated ? [atMost(left, right)] : [above(left, right)]
    case '>=':
      return negated ? [below(left, right)] : [atLeast(left, right)]
    case '==':
      return negated ? [] : [atMost(left, right), atLeast(left, right)] // can't assume a disequality
    default:
      return []
  }
}

// equality assumptions from an immutable binding `x = e` (only when e is linear): x <= e and x >= e
function bindingEqualities(
  name: string,
  value: Expression,
  side: Inequality[],
): Inequality[] {
  const rhs = toLinear(value, side)

  if (!rhs) {
    return []
  }

  const lhs = linear({ [name]: 1 })

  return [atMost(lhs, rhs), atLeast(lhs, rhs)]
}

export function checkHolds(
  program: Program,
  file: string,
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []

  for (const statement of program) {
    if (statement.form === 'function') {
      // base assumptions from parameter refinements: a natural-number parameter is >= 0
      const base = statement.params
        .filter(p => p.refine === 'natural')
        .map(p => atLeast(linear({ [p.name]: 1 }), linear({}, 0)))

      walkHolds(statement.body, base, diagnostics, file)
    } else if (statement.form === 'hold') {
      // a top-level `hold` declared at module scope: prove it with no assumptions (it has no enclosing parameters).
      // This is what lets a value-arithmetic obligation at the top level (e.g. `add 3 3 == 6`) be discharged by the
      // linear prover, the same as one inside a function body. The kernel pass (elaborate) handles the definitional
      // fragment and records its discharges, which the caller drops from these diagnostics.
      walkHolds([statement], [], diagnostics, file)
    }
  }

  return diagnostics
}

// walk a body in order, threading the path assumptions: branch conditions refine their branches, the else branch
// assumes the negation, and an immutable binding contributes its defining equality to what follows.
function walkHolds(
  body: Statement[],
  assumptions: Inequality[],
  diagnostics: Diagnostic[],
  file: string,
): void {
  let current = assumptions

  for (const statement of body) {
    switch (statement.form) {
      case 'hold': {
        // discharge the goal, handling its propositional structure (conjunction, disjunction) and the comparisons
        const verdict = goalProvable(statement.expr, current)

        if (verdict === null) {
          diagnostics.push(
            diagnose('unchecked-hold', {
              file,
              span: statement.span,
              message:
                'this hold is outside the decidable linear fragment and was not proven',
            }),
          )
        } else if (verdict === false) {
          diagnostics.push(
            diagnose('unproven', {
              file,
              span: statement.span,
              message:
                'this hold could not be proven from the available assumptions',
            }),
          )
        }

        break
      }

      case 'let':
        // an immutable binding (host) introduces a stable equality; a reassignable one (save) does not
        if (!statement.mutable) {
          const side: Inequality[] = []
          const equalities = bindingEqualities(
            statement.name,
            statement.init,
            side,
          )

          current = [...current, ...side, ...equalities]
        }

        break

      case 'if': {
        const negations: Inequality[] = []

        for (const branch of statement.branches) {
          const side: Inequality[] = []
          const conditions = assumptionInequalities(
            branch.cond,
            false,
            side,
          )

          walkHolds(
            branch.body,
            [...current, ...side, ...conditions],
            diagnostics,
            file,
          )
          negations.push(
            ...assumptionInequalities(branch.cond, true, []),
          )
        }

        if (statement.otherwise) {
          walkHolds(
            statement.otherwise,
            [...current, ...negations],
            diagnostics,
            file,
          )
        }

        break
      }

      case 'while': {
        // the loop body runs only when the condition holds
        const side: Inequality[] = []
        const conditions = assumptionInequalities(
          statement.cond,
          false,
          side,
        )

        walkHolds(
          statement.body,
          [...current, ...side, ...conditions],
          diagnostics,
          file,
        )
        break
      }

      case 'for-each':
        walkHolds(statement.body, current, diagnostics, file)
        break
      case 'match':
        for (const branch of statement.cases) {
          walkHolds(branch.body, current, diagnostics, file)
        }

        if (statement.otherwise) {
          walkHolds(statement.otherwise, current, diagnostics, file)
        }

        break
      default:
        break
    }
  }
}
