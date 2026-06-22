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

// the greatest common divisor of two non-negative integers (Euclid). Used by the omega gcd test on disequality goals;
// gcd(0, n) = n folds a coefficient list from a 0 seed.
function greatestCommonDivisor(a: number, b: number): number {
  let x = Math.abs(Math.round(a))
  let y = Math.abs(Math.round(b))

  while (y !== 0) {
    ;[x, y] = [y, x % y]
  }

  return x
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

// ===== structural positivity (the nonlinear companion the linear prover lacks) =====
// A SQUARE `a * a` is >= 0 for any value of `a`, and sums / products of non-negative parts stay non-negative. These
// facts are outside the linear fragment (a square is variable*variable, which `toLinear` rejects) yet trivially true,
// and the kernel cannot see them either (opaque literals). Sound over any ordered ring.

// syntactic equality on the arithmetic fragment, so `a * a` is recognised as a square (`a` matched against `a`).
function sameExpression(a: Expression, b: Expression): boolean {
  if (a.form !== b.form) {
    return false
  }

  if (a.form === 'integer' && b.form === 'integer') {
    return a.value === b.value
  }

  if (a.form === 'variable' && b.form === 'variable') {
    return a.name === b.name
  }

  if (a.form === 'binary' && b.form === 'binary') {
    return (
      a.op === b.op &&
      sameExpression(a.left, b.left) &&
      sameExpression(a.right, b.right)
    )
  }

  return false
}

// is `expr` structurally >= 0: a non-negative literal, a square, or a sum / product of non-negative parts.
function nonNegativeExpression(expr: Expression): boolean {
  if (expr.form === 'integer') {
    return Number(expr.value) >= 0
  }

  if (expr.form === 'binary') {
    // a SQUARE is non-negative regardless of the sign of its base
    if (expr.op === '*' && sameExpression(expr.left, expr.right)) {
      return true
    }

    if (expr.op === '+' || expr.op === '*') {
      return (
        nonNegativeExpression(expr.left) &&
        nonNegativeExpression(expr.right)
      )
    }
  }

  return false
}

// is `expr` structurally > 0: a positive literal, a product of positives, or a sum with a positive part. (A square is
// only >= 0 -- its base may be zero -- so it does not certify strict positivity.)
function positiveExpression(expr: Expression): boolean {
  if (expr.form === 'integer') {
    return Number(expr.value) > 0
  }

  if (expr.form === 'binary') {
    if (expr.op === '+') {
      return (
        (positiveExpression(expr.left) &&
          nonNegativeExpression(expr.right)) ||
        (nonNegativeExpression(expr.left) &&
          positiveExpression(expr.right))
      )
    }

    if (expr.op === '*') {
      return (
        positiveExpression(expr.left) && positiveExpression(expr.right)
      )
    }
  }

  return false
}

// a POSITIVITY goal proven structurally: `e >= 0` / `0 <= e` (non-negativity) or `e > 0` / `0 < e` (positivity), where
// the non-zero side is a recognised non-negative / positive arithmetic expression. Returns false when it does not apply
// (so the caller falls through to the linear prover, which still owns every linear non-negativity goal).
function positivityProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  const isZero = (e: Expression): boolean =>
    e.form === 'integer' && Number(e.value) === 0

  switch (expr.op) {
    case '>=':
      return isZero(expr.right) && nonNegativeExpression(expr.left)
    case '<=':
      return isZero(expr.left) && nonNegativeExpression(expr.right)
    case '>':
      return isZero(expr.right) && positiveExpression(expr.left)
    case '<':
      return isZero(expr.left) && positiveExpression(expr.right)
    default:
      return false
  }
}

// ===== multivariate quadratic non-negativity (the nonlinear `nia` decision via positive-semidefiniteness) =====
// A real quadratic q(x) = x^T M x + b^T x + c is >= 0 for ALL x iff the augmented symmetric matrix A = [[M, b/2],
// [(b/2)^T, c]] is positive SEMIDEFINITE, and q > 0 everywhere iff A is positive DEFINITE. PSD is decided exactly by
// "every principal minor >= 0" and PD by "every LEADING principal minor > 0" (Sylvester). We scale A by 2 to keep an
// integer matrix (PSD/PD are invariant under a positive scaling), so the minors are exact integer determinants -- no
// floating-point unsoundness. Real non-negativity implies integer non-negativity, so the verdict is sound for Seed's
// integer variables, and it is COMPLETE for the quadratic fragment in any number of variables. It catches forms not
// written as a square -- `(x-1)^2` as `x^2 + 1 >= 2x`, `(a-b)^2` as `a^2 + b^2 >= 2 a b` -- i.e. a sum-of-squares
// certificate without naming the squares.

// a polynomial of degree <= 2 as a map from a canonical monomial key to its integer coefficient. The key is the sorted
// variable list joined by NUL: '' = constant, 'x' = linear, 'x\0x' = a square, 'x\0y' = a cross term.
type Poly = Map<string, number>

const monomialKey = (vars: string[]): string => [...vars].sort().join(' ')

const monomialVars = (key: string): string[] =>
  key === '' ? [] : key.split(' ')

// expand an arithmetic expression into its polynomial, or null if it is not a polynomial of degree <= 2 (a degree-3+
// monomial appears). Coefficients stay exact integers.
function expandPolynomial(expr: Expression): Poly | null {
  if (expr.form === 'integer') {
    return new Map([['', Number(expr.value)]])
  }

  if (expr.form === 'variable') {
    return new Map([[expr.name, 1]])
  }

  if (expr.form === 'binary') {
    const left = expandPolynomial(expr.left)
    const right = expandPolynomial(expr.right)

    if (!left || !right) {
      return null
    }

    if (expr.op === '+' || expr.op === '-') {
      const sign = expr.op === '+' ? 1 : -1
      const out: Poly = new Map(left)

      for (const [key, value] of right) {
        out.set(key, (out.get(key) ?? 0) + sign * value)
      }

      return out
    }

    if (expr.op === '*') {
      const out: Poly = new Map()

      for (const [k1, v1] of left) {
        for (const [k2, v2] of right) {
          const key = monomialKey([
            ...monomialVars(k1),
            ...monomialVars(k2),
          ])
          out.set(key, (out.get(key) ?? 0) + v1 * v2)
        }
      }

      return out
    }
  }

  return null
}

// the degree of a polynomial: the largest number of variables (with multiplicity) in any monomial with a non-zero
// coefficient.
function polynomialDegree(poly: Poly): number {
  let degree = 0

  for (const [key, coefficient] of poly) {
    if (coefficient !== 0) {
      degree = Math.max(degree, monomialVars(key).length)
    }
  }

  return degree
}

// is every monomial of `poly` manifestly non-negative -- each variable to an EVEN power (so the monomial is a perfect
// square, e.g. a^2 b^4 = (a b^2)^2) with a non-negative coefficient? Then the whole polynomial is a sum of non-negative
// terms, hence >= 0 everywhere, at ANY degree (a diagonal sum-of-squares certificate). For STRICT positivity the
// constant term must be positive (at the origin every non-constant monomial vanishes). Sound over any ordered ring.
function evenMonomialNonNegative(poly: Poly, strict: boolean): boolean {
  let constant = 0

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    if (coefficient < 0) {
      return false
    }

    const counts = new Map<string, number>()

    for (const v of monomialVars(key)) {
      counts.set(v, (counts.get(v) ?? 0) + 1)
    }

    for (const c of counts.values()) {
      if (c % 2 !== 0) {
        return false // an odd power can be negative, so the monomial is not manifestly non-negative
      }
    }

    if (key === '') {
      constant = coefficient
    }
  }

  return strict ? constant > 0 : true
}

// the integer augmented symmetric matrix (2A, scaled to integers) of a quadratic polynomial: variables index the
// leading rows/columns, the final row/column carries the linear and constant terms.
function quadraticMatrix(poly: Poly): number[][] {
  const variables = new Set<string>()

  for (const key of poly.keys()) {
    for (const v of monomialVars(key)) {
      variables.add(v)
    }
  }

  const order = [...variables].sort()
  const index = new Map(order.map((v, i) => [v, i]))
  const size = order.length + 1 // the extra index is the constant component
  const last = order.length

  const matrix = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  )

  for (const [key, coefficient] of poly) {
    const vars = monomialVars(key)

    if (vars.length === 0) {
      matrix[last]![last]! += 2 * coefficient // constant c -> A[last][last] = c, scaled by 2
    } else if (vars.length === 1) {
      const i = index.get(vars[0]!)!
      matrix[i]![last]! += coefficient // linear b_i -> A[i][last] = b_i/2, scaled by 2
      matrix[last]![i]! += coefficient
    } else {
      const i = index.get(vars[0]!)!
      const j = index.get(vars[1]!)!

      if (i === j) {
        matrix[i]![i]! += 2 * coefficient // square x_i^2 -> A[i][i] = coeff, scaled by 2
      } else {
        matrix[i]![j]! += coefficient // cross x_i x_j -> A[i][j] = coeff/2, scaled by 2
        matrix[j]![i]! += coefficient
      }
    }
  }

  return matrix
}

// the exact integer determinant of a small integer matrix (cofactor expansion; sizes here are tiny -- the variable
// count of one goal). `Math.round` removes any floating drift from the multiply/add on integer inputs.
function determinant(matrix: number[][]): number {
  const n = matrix.length

  if (n === 0) return 1
  if (n === 1) return matrix[0]![0]!
  if (n === 2) {
    return matrix[0]![0]! * matrix[1]![1]! - matrix[0]![1]! * matrix[1]![0]!
  }

  let total = 0

  for (let column = 0; column < n; column++) {
    const minor = matrix
      .slice(1)
      .map(row => row.filter((_, j) => j !== column))
    total +=
      (column % 2 === 0 ? 1 : -1) * matrix[0]![column]! * determinant(minor)
  }

  return Math.round(total)
}

const submatrix = (matrix: number[][], indices: number[]): number[][] =>
  indices.map(i => indices.map(j => matrix[i]![j]!))

// positive SEMIDEFINITE: every principal minor (every diagonal-aligned square submatrix's determinant) is >= 0.
function isPositiveSemidefinite(matrix: number[][]): boolean {
  const n = matrix.length

  for (let mask = 1; mask < 1 << n; mask++) {
    const indices: number[] = []

    for (let i = 0; i < n; i++) {
      if (mask & (1 << i)) indices.push(i)
    }

    if (determinant(submatrix(matrix, indices)) < 0) {
      return false
    }
  }

  return true
}

// positive DEFINITE (Sylvester): every LEADING principal minor is > 0.
function isPositiveDefinite(matrix: number[][]): boolean {
  for (let k = 1; k <= matrix.length; k++) {
    const indices = Array.from({ length: k }, (_, i) => i)

    if (determinant(submatrix(matrix, indices)) <= 0) {
      return false
    }
  }

  return true
}

// a goal `L >= R` / `L > R` (and the flipped `<=` / `<`) proven by the PSD test: the difference `L - R` (resp. `R - L`)
// is a non-negative (resp. positive) quadratic in any number of variables. Returns false when the fragment does not
// apply (a non-polynomial sub-term, or degree above 2).
function quadraticProves(expr: Expression): boolean {
  if (
    expr.form !== 'binary' ||
    !['>=', '>', '<=', '<'].includes(expr.op)
  ) {
    return false
  }

  const upper = expr.op === '>=' || expr.op === '>' ? expr.left : expr.right
  const lower = expr.op === '>=' || expr.op === '>' ? expr.right : expr.left
  const strict = expr.op === '>' || expr.op === '<'

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  // difference = upper - lower, the polynomial the claim asserts is non-negative (or positive)
  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  // a manifestly non-negative diagonal sum of squares works at ANY degree (a^4 + b^4, (a^2+b^2)^2, ...)
  if (evenMonomialNonNegative(difference, strict)) {
    return true
  }

  // the COMPLETE quadratic decision (positive-(semi)definiteness) applies only at degree <= 2; a higher-degree form
  // that is not a diagonal SOS is left to a future genuine SOS / SDP procedure rather than mishandled.
  if (polynomialDegree(difference) > 2) {
    return false
  }

  const matrix = quadraticMatrix(difference)

  return strict
    ? isPositiveDefinite(matrix)
    : isPositiveSemidefinite(matrix)
}

// the combined nonlinear non-negativity check: higher-degree sums/products of squares (`positivityProves`, e.g.
// `(a*a)*(b*b) >= 0`) OR a quadratic-fragment goal by positive-semidefiniteness (`quadraticProves`). Both are
// assumption-free and sound over the reals / any ordered ring; together they discharge the common nonlinear `>= 0` /
// `>` goals the linear prover cannot.
// is a UNIVARIATE polynomial a perfect square q^2 (hence >= 0 everywhere)? This catches non-diagonal forms the
// even-monomial test misses -- `x^4 - 2x^3 + 3x^2 - 2x + 1 = (x^2 - x + 1)^2` -- by recovering q from the top
// coefficients and VERIFYING q^2 == p exactly (the verification is the soundness guarantee). Restricted to a single
// variable with an integer square root; a non-perfect-square or multivariate polynomial declines (sound, incomplete).
function univariatePerfectSquare(poly: Poly): boolean {
  const variables = new Set<string>()

  for (const key of poly.keys()) {
    for (const v of monomialVars(key)) {
      variables.add(v)
    }
  }

  if (variables.size !== 1) {
    return false // multivariate perfect squares need a full SOS / SDP search
  }

  const coefficientOfDegree = new Map<number, number>()
  let degree = 0

  for (const [key, coefficient] of poly) {
    const d = monomialVars(key).length

    coefficientOfDegree.set(d, coefficient)

    if (coefficient !== 0 && d > degree) {
      degree = d
    }
  }

  if (degree < 2 || degree % 2 !== 0) {
    return false
  }

  const c = (k: number): number => coefficientOfDegree.get(k) ?? 0
  const d = degree / 2
  const top = c(degree)
  const root = Math.round(Math.sqrt(top))

  if (top <= 0 || root * root !== top) {
    return false // leading coefficient is not a positive perfect square
  }

  // recover q (degree d) from the top d+1 coefficients: coeff of x^(d+i) is 2 q[d] q[i] + (terms among q[i+1..d-1])
  const q = new Array<number>(d + 1).fill(0)
  q[d] = root

  for (let i = d - 1; i >= 0; i--) {
    let known = 0

    for (let j = i + 1; j <= d - 1; j++) {
      known += q[j]! * q[d + i - j]!
    }

    const numerator = c(d + i) - known

    if (numerator % (2 * root) !== 0) {
      return false // q would need a non-integer coefficient
    }

    q[i] = numerator / (2 * root)
  }

  // the remaining coefficients (x^0 .. x^(d-1)) must agree with q^2, or p is not q^2
  for (let m = 0; m < d; m++) {
    let sum = 0

    for (let j = 0; j <= m; j++) {
      sum += q[j]! * q[m - j]!
    }

    if (sum !== c(m)) {
      return false
    }
  }

  return true
}

// a goal `L >= R` (or `R <= L`) whose difference is a univariate perfect square. A square is >= 0 but not strictly
// > 0, so only the non-strict directions qualify.
function perfectSquareProves(expr: Expression): boolean {
  if (expr.form !== 'binary' || (expr.op !== '>=' && expr.op !== '<=')) {
    return false
  }

  const upper = expr.op === '>=' ? expr.left : expr.right
  const lower = expr.op === '>=' ? expr.right : expr.left
  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  return univariatePerfectSquare(difference)
}

function nonlinearProves(expr: Expression): boolean {
  return (
    positivityProves(expr) ||
    quadraticProves(expr) ||
    perfectSquareProves(expr)
  )
}

type Inequality = ReturnType<typeof atMost>

// two linear forms that are exact negatives (b == -a): the pair of non-strict constraints `a <= 0` and `-a <= 0` is
// how an equality `a == 0` is recorded among the assumptions.
function negatesLinear(a: Linear, b: Linear): boolean {
  if (Math.abs(a.constant + b.constant) > 1e-9) {
    return false
  }

  const keys = new Set<string>([...a.terms.keys(), ...b.terms.keys()])

  for (const k of keys) {
    if (Math.abs((a.terms.get(k) ?? 0) + (b.terms.get(k) ?? 0)) > 1e-9) {
      return false
    }
  }

  return true
}

// are the assumptions INTEGER-INCONSISTENT? A pair `a <= 0`, `-a <= 0` encodes `a == 0`, i.e. `sum ci*xi == -const`; by
// Bezout that has no integer solution when gcd(|ci|) does not divide the constant. Such an assumption can never hold,
// so the branch is unreachable and EVERY goal in it is vacuously true (ex falso). Sound for the same reason as the
// disequality gcd test: Seed's binary +/-/* are integer-only, so any coefficient |c| > 1 (the only case the gcd test
// fires) guarantees integer variables. This catches contradictions the rational Fourier-Motzkin prover cannot (it
// reads `2 a == 3` as satisfiable at a = 3/2).
function integerInconsistent(assumptions: Inequality[]): boolean {
  for (let i = 0; i < assumptions.length; i++) {
    const a = assumptions[i]!

    if (a.strict) {
      continue
    }

    const isEquality = assumptions.some(
      (b, j) => j !== i && !b.strict && negatesLinear(a.linear, b.linear),
    )

    if (!isEquality) {
      continue
    }

    const coefficients = [...a.linear.terms.values()]
      .map(Math.abs)
      .filter(c => c > 1e-12)
      .map(Math.round)

    if (coefficients.length === 0) {
      // a pure constant equation `const == 0` is contradictory exactly when the constant is non-zero
      if (Math.abs(a.linear.constant) > 1e-9) {
        return true
      }

      continue
    }

    const divisor = coefficients.reduce(greatestCommonDivisor, 0)

    if (divisor > 1 && Math.round(a.linear.constant) % divisor !== 0) {
      return true
    }
  }

  return false
}

// a hold goal: the list of inequalities that must ALL hold (an equality goal splits into two), or null if the
// comparison is outside the linear fragment (then it cannot be discharged here). Mod side-constraints go in `side`.
// whether a hold's goal lies in the decidable linear fragment (both sides translate to linear forms). The kernel
// proof layer (elaborate) skips these so the linear prover here is the single authority for arithmetic, which is what
// keeps it from wrongly discharging a value-false claim like `add 3 3 == add 4 4` (the kernel treats number literals
// opaquely, so it cannot tell 6 from 8; the linear prover can).
export function isLinearGoal(expr: Expression): boolean {
  // a nonlinear non-negativity goal (`x*x >= 0`, a sum/product of non-negatives, or a univariate quadratic by its
  // discriminant) is outside both the linear translation and the kernel; claim the ones we actually prove here.
  if (nonlinearProves(expr)) {
    return true
  }

  // a DISEQUALITY `L != R` is in the arithmetic fragment when both sides translate to linear forms. The kernel cannot
  // prove arithmetic disequalities (it views number literals opaquely, so it can never tell 6 from 8), so claiming
  // these here is the right division of labor and never steals a constructor disequality (`succ n != zero`, whose
  // sides are `make`/`call` terms `toLinear` rejects) from the kernel's no-confusion.
  if (expr.form === 'binary' && expr.op === '!=') {
    const side: Inequality[] = []

    return toLinear(expr.left, side) !== undefined &&
      toLinear(expr.right, side) !== undefined
  }

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
  // EX FALSO: if the assumptions have no integer solution, the branch is unreachable and every goal holds vacuously.
  if (integerInconsistent(available)) {
    return true
  }

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

  // a nonlinear non-negativity goal (`x*x >= 0`, a univariate quadratic, etc.) is discharged directly: it holds for
  // every assignment, no assumptions needed. Tried before the linear translation, which cannot represent it.
  if (nonlinearProves(expr)) {
    return true
  }

  // a DISEQUALITY goal `L != R` is provable when the assumptions force a STRICT SEPARATION: `L < R` everywhere, or
  // `L > R` everywhere. Two values that are strictly ordered are never equal, so this is sound over any ordered
  // domain (rationals and integers alike), and it discharges the recurring arithmetic "unequal" facts (`n + 1 != 0`
  // for a natural n, `i != i + 1`) without a manual case split. The full integer (omega) disequality via a gcd /
  // tightening certificate is a later rung; strict separation is the common, cheap case and never unsound.
  if (expr.form === 'binary' && expr.op === '!=') {
    const dside: Inequality[] = []
    const left = toLinear(expr.left, dside)
    const right = toLinear(expr.right, dside)

    if (!left || !right) {
      return null
    }

    const all = [...available, ...dside]

    if (proves(all, below(left, right)) || proves(all, above(left, right))) {
      return true
    }

    // the integer (omega) gcd test, for disequalities NOT settled by strict separation (e.g. `2 a + 4 b != 3`). The
    // equation `L == R` rearranges to `sum ci*xi == -const`; by Bezout it has an integer solution iff gcd(|ci|)
    // divides the constant. When it does NOT, `L == R` is unsatisfiable over the integers, so `L != R` holds for
    // every assignment. SOUND here because Seed's binary +/-/* are integer-only (rationals/reals are constructed and
    // never reach `toLinear`), so any coefficient with |c| > 1 -- the sole case where the gcd can exceed 1 and the
    // test fire -- guarantees its variable ranges over the integers. With all unit coefficients the gcd is 1, divides
    // everything, and the test never fires, so a bare rational variable comparison is untouched.
    const diff = add(left, scale(right, -1))
    const coefficients = [...diff.terms.values()]
      .map(Math.abs)
      .filter(c => c !== 0)

    if (coefficients.length === 0) {
      // no variables remain: a pure-constant disequality holds exactly when the constants differ
      return diff.constant !== 0
    }

    const divisor = coefficients.reduce(greatestCommonDivisor, 0)

    // `L == R` has no integer solution when the shared factor of the variable coefficients does not divide the
    // constant term; then `L != R` is a theorem.
    return divisor > 1 && diff.constant % divisor !== 0
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
