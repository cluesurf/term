// Refinement-type verification: layer 2 of the type system (see note/research/vibe/computation/plans/04-typecheck.md).
// Refinements are linear constraints over integers (n >= 0, i < len, ...). A `hold` clause becomes a verification
// condition: do the assumptions imply the goal? We discharge it with a sound, self-contained linear-arithmetic
// decision procedure (Fourier-Motzkin elimination), so no external SMT solver and it runs in the browser.
//
// This is the proof engine. Wiring `hold` clauses from the mill into verification conditions is the next surface
// step; this module is the discharger and is tested directly on constraints.

// a linear expression: sum of coefficient * variable, plus a constant
export type Linear = { terms: Map<string, number>; constant: number }

// a constraint: linear <= 0 (or strictly < 0)
type Inequality = { linear: Linear; strict: boolean }

// ---- linear expression builders ----
export function linear(terms: Record<string, number>, constant = 0): Linear {
  return { terms: new Map(Object.entries(terms)), constant }
}

function scale(a: Linear, k: number): Linear {
  const terms = new Map<string, number>()
  for (const [v, c] of a.terms) terms.set(v, c * k)
  return { terms, constant: a.constant * k }
}

function plus(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms)
  for (const [v, c] of b.terms) terms.set(v, (terms.get(v) ?? 0) + c)
  return { terms, constant: a.constant + b.constant }
}

// ---- public comparison builders (each returns an Inequality in `<= 0` / `< 0` form) ----
// a <= b   ->   a - b <= 0
export const atMost = (a: Linear, b: Linear): Inequality => ({ linear: plus(a, scale(b, -1)), strict: false })
// a < b    ->   a - b < 0
export const below = (a: Linear, b: Linear): Inequality => ({ linear: plus(a, scale(b, -1)), strict: true })
// a >= b   ->   b - a <= 0
export const atLeast = (a: Linear, b: Linear): Inequality => atMost(b, a)
// a > b    ->   b - a < 0
export const above = (a: Linear, b: Linear): Inequality => below(b, a)

// negate a constraint (for refutation): not(l <= 0) is l > 0 i.e. -l < 0; not(l < 0) is l >= 0 i.e. -l <= 0
function negate(ineq: Inequality): Inequality {
  return { linear: scale(ineq.linear, -1), strict: !ineq.strict }
}

function variables(ineqs: Array<Inequality>): Array<string> {
  const set = new Set<string>()
  for (const ineq of ineqs) for (const v of ineq.linear.terms.keys()) if (Math.abs(ineq.linear.terms.get(v)!) > 1e-12) set.add(v)
  return [...set]
}

function coeff(ineq: Inequality, v: string): number {
  return ineq.linear.terms.get(v) ?? 0
}

// eliminate one variable by Fourier-Motzkin: combine each positive-coefficient row with each negative one
function eliminate(ineqs: Array<Inequality>, v: string): Array<Inequality> {
  const positive: Array<Inequality> = []
  const negative: Array<Inequality> = []
  const free: Array<Inequality> = []
  for (const ineq of ineqs) {
    const c = coeff(ineq, v)
    if (c > 1e-12) positive.push(ineq)
    else if (c < -1e-12) negative.push(ineq)
    else free.push(ineq)
  }
  const out = [...free]
  for (const p of positive) {
    const cp = coeff(p, v)
    for (const n of negative) {
      const cn = coeff(n, v)
      // (-cn) * p + (cp) * n  cancels v (both multipliers positive)
      const combined = plus(scale(p.linear, -cn), scale(n.linear, cp))
      out.push({ linear: combined, strict: p.strict || n.strict })
    }
  }
  return out
}

// is the system of constraints unsatisfiable?
function unsatisfiable(ineqs: Array<Inequality>): boolean {
  // integer tightening: the program variables are integers, so a strict `l < 0` is exactly `l + 1 <= 0`. Tightening
  // up front makes the procedure integer-sound (it now proves e.g. n > 0 => n >= 1, which is false over rationals).
  let system = ineqs.map((ineq) => (ineq.strict ? { linear: { terms: ineq.linear.terms, constant: ineq.linear.constant + 1 }, strict: false } : ineq))
  for (const v of variables(system)) system = eliminate(system, v)
  // every remaining constraint is `constant <= 0`; a positive constant is a contradiction
  for (const ineq of system) {
    if (ineq.linear.constant > 1e-9) return true
  }
  return false
}

// does the conjunction of assumptions imply the goal? (the verification condition is valid)
export function proves(assumptions: Array<Inequality>, goal: Inequality): boolean {
  // valid iff assumptions AND not(goal) is unsatisfiable
  return unsatisfiable([...assumptions, negate(goal)])
}
