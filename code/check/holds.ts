// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in refine.ts. An unprovable hold is a
// diagnostic. See note/research/vibe/computation/plans/04-typecheck.md. Browser-safe.

import type { Diagnostic } from '@/code/parser/diagnostic'
import { diagnose } from '@/code/parser/diagnostic'
import type { Expression, Program, Statement } from '@/code/compile/node'
import type { Linear } from '@/code/check/refine'
import { above, atLeast, atMost, below, linear, proves } from '@/code/check/refine'

// translate a compile-AST expression into a linear form, or undefined if it is not linear
function toLinear(expr: Expression): Linear | undefined {
  switch (expr.form) {
    case 'integer':
      return linear({}, Number(expr.value))
    case 'variable':
      return linear({ [expr.name]: 1 })
    case 'binary': {
      const left = toLinear(expr.left)
      const right = toLinear(expr.right)
      if (!left || !right) return undefined
      if (expr.op === '+') return add(left, right)
      if (expr.op === '-') return add(left, scale(right, -1))
      if (expr.op === '*') {
        const lc = constantOf(left)
        const rc = constantOf(right)
        if (rc !== undefined) return scale(left, rc)
        if (lc !== undefined) return scale(right, lc)
        return undefined // non-linear
      }
      return undefined
    }
    default:
      return undefined
  }
}

function add(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms)
  for (const [v, c] of b.terms) terms.set(v, (terms.get(v) ?? 0) + c)
  return { terms, constant: a.constant + b.constant }
}
function scale(a: Linear, k: number): Linear {
  const terms = new Map<string, number>()
  for (const [v, c] of a.terms) terms.set(v, c * k)
  return { terms, constant: a.constant * k }
}
// if a linear form is a pure constant (no variables), return it
function constantOf(a: Linear): number | undefined {
  for (const c of a.terms.values()) if (Math.abs(c) > 1e-12) return undefined
  return a.constant
}

// translate a comparison expression into an inequality (the goal), or undefined
function toInequality(expr: Expression): ReturnType<typeof atMost> | undefined {
  if (expr.form !== 'binary') return undefined
  const left = toLinear(expr.left)
  const right = toLinear(expr.right)
  if (!left || !right) return undefined
  switch (expr.op) {
    case '<':
      return below(left, right)
    case '<=':
      return atMost(left, right)
    case '>':
      return above(left, right)
    case '>=':
      return atLeast(left, right)
    default:
      return undefined
  }
}

export function checkHolds(program: Program, file: string): Array<Diagnostic> {
  const diagnostics: Array<Diagnostic> = []

  for (const statement of program) {
    if (statement.form !== 'function') continue

    // assumptions from parameter refinements: natural-number means param >= 0
    const assumptions = statement.params
      .filter((p) => p.refine === 'natural')
      .map((p) => atLeast(linear({ [p.name]: 1 }), linear({}, 0)))

    collectHolds(statement.body, (hold) => {
      const goal = toInequality(hold.expr)
      if (!goal) return // not a linear comparison; out of this layer's scope, leave it
      if (!proves(assumptions, goal)) {
        diagnostics.push(
          diagnose('unproven', {
            file,
            span: hold.span,
            message: 'this hold could not be proven from the available assumptions',
          }),
        )
      }
    })
  }

  return diagnostics
}

function collectHolds(body: Array<Statement>, visit: (hold: Extract<Statement, { form: 'hold' }>) => void): void {
  for (const statement of body) {
    switch (statement.form) {
      case 'hold':
        visit(statement)
        break
      case 'while':
      case 'for-each':
        collectHolds(statement.body, visit)
        break
      case 'if':
        for (const branch of statement.branches) collectHolds(branch.body, visit)
        if (statement.otherwise) collectHolds(statement.otherwise, visit)
        break
      default:
        break
    }
  }
}
