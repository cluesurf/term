// A commutative-ring equality decision procedure. It normalizes a polynomial expression (integer literals, variables,
// and +, -, *) into a canonical sum of monomials, and decides L == R by checking that L - R is the zero polynomial.
// A zero polynomial is identically zero over any commutative ring, so this proves a NONLINEAR algebraic identity for
// ALL values of its variables -- the multiplicative norm (the Brahmagupta-Fibonacci identity), the four-square
// identity, the doubling identities -- which the linear prover (degree one only) and the kernel's postulated
// arithmetic cannot. It is sound and decidable. It handles only +, -, * over the integers; anything else (division,
// a function call, a non-integer literal) makes it decline (return false), leaving the goal to the other provers.

import type { Expression } from '@cluesurf/make/code/compile/node'

// a polynomial maps each monomial (a canonical key over its variables, "" for the constant) to an integer coefficient
type Poly = Map<string, number>

// the canonical key for a monomial given its variable powers (sorted, so a*b and b*a agree)
function monoKey(powers: Map<string, number>): string {
  const parts: Array<string> = []
  for (const [v, p] of [...powers].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  ))
    if (p > 0) parts.push(p === 1 ? v : `${v}^${p}`)
  return parts.join('*')
}

// the variable powers of a monomial key
function monoPowers(key: string): Map<string, number> {
  const powers = new Map<string, number>()
  if (key === '') return powers
  for (const factor of key.split('*')) {
    const [v, p] = factor.split('^')
    powers.set(v!, (powers.get(v!) ?? 0) + (p ? Number(p) : 1))
  }
  return powers
}

function addInto(poly: Poly, key: string, coeff: number): void {
  const next = (poly.get(key) ?? 0) + coeff
  if (next === 0) poly.delete(key)
  else poly.set(key, next)
}

function addPoly(a: Poly, b: Poly): Poly {
  const out: Poly = new Map(a)
  for (const [k, c] of b) addInto(out, k, c)
  return out
}

function scalePoly(a: Poly, k: number): Poly {
  const out: Poly = new Map()
  for (const [m, c] of a) out.set(m, c * k)
  return out
}

function mulPoly(a: Poly, b: Poly): Poly {
  const out: Poly = new Map()
  for (const [ma, ca] of a)
    for (const [mb, cb] of b) {
      const powers = monoPowers(ma)
      for (const [v, p] of monoPowers(mb))
        powers.set(v, (powers.get(v) ?? 0) + p)
      addInto(out, monoKey(powers), ca * cb)
    }
  return out
}

function toPoly(expr: Expression): Poly | null {
  switch (expr.form) {
    case 'integer': {
      const n = Number(expr.value)
      if (!Number.isInteger(n)) return null
      // keep the invariant that a Poly never stores a zero coefficient: the literal 0 is the empty polynomial, the
      // same normal form mulPoly / addPoly produce. Otherwise `0` would normalize to {'': 0} (size 1) while `0 * 0`
      // normalizes to {} (size 0), and ringEqual(0, 0 * 0) would wrongly fail (it compares by difference size).
      return n === 0 ? new Map() : new Map([['', n]])
    }
    case 'variable':
      return new Map([[expr.name, 1]])
    case 'binary': {
      const l = toPoly(expr.left)
      const r = toPoly(expr.right)
      if (!l || !r) return null
      if (expr.op === '+') return addPoly(l, r)
      if (expr.op === '-') return addPoly(l, scalePoly(r, -1))
      if (expr.op === '*') return mulPoly(l, r)
      return null
    }
    default:
      return null
  }
}

// decide L == R as a commutative-ring identity: true iff L - R normalizes to the zero polynomial. False means either
// they are not an identity or they fall outside the +/-/* integer fragment, in which case the goal is left to the
// other provers.
export function ringEqual(
  left: Expression,
  right: Expression,
): boolean {
  const l = toPoly(left)
  const r = toPoly(right)
  if (!l || !r) return false
  return addPoly(l, scalePoly(r, -1)).size === 0
}

// is a polynomial MANIFESTLY non-negative: a non-negative constant plus a sum of square monomials (every variable
// power even, with a non-negative coefficient)? Sound: such a polynomial is at least zero for all integer values,
// since each term is a non-negative coefficient times a perfect square. Incomplete (it does not search for a general
// sum-of-squares decomposition, so it misses e.g. a*a - 2*a*b + b*b = (a-b)^2), but it is decidable and covers "every
// square is non-negative" and sums of squares.
function polyNonNegative(d: Poly): boolean {
  for (const [mono, coeff] of d) {
    if (coeff < 0) return false
    for (const power of monoPowers(mono).values())
      if (power % 2 !== 0) return false
  }
  return true
}

// decide `left >= right` for ALL values by showing left - right is manifestly non-negative (a sum of square monomials
// plus a non-negative constant). Proves "n*n >= 0", "a*a + b*b >= 0", and the like, which the linear prover (degree
// one) cannot. False when it is not of this form or falls outside the +/-/* integer fragment.
export function nonNegativeDifference(
  left: Expression,
  right: Expression,
): boolean {
  const l = toPoly(left)
  const r = toPoly(right)
  if (!l || !r) return false
  return polyNonNegative(addPoly(l, scalePoly(r, -1)))
}
