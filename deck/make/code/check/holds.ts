// The hold-checker: closes refinement layer 2 end to end. It translates each function's `hold` clauses (the
// goals) and its parameters' refinements (the assumptions, e.g. natural-number means n >= 0) into linear
// constraints, then discharges the goals with the Fourier-Motzkin prover in refine.ts. An unprovable hold is a
// diagnostic. See note/research/vibe/computation/plans/04-typecheck.md. Browser-safe.

import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { diagnose } from '@term/make/code/parser/diagnostic'
import type {
  Expression,
  HoldOrigin,
  Program,
  Statement,
} from '@term/make/code/compile/node'
import type { Linear } from '@term/make/code/check/refine'
import {
  callsImpure,
  EVERYTHING,
  freshNames,
  functionNames,
  lengthKeepingFunctions,
  localNames,
  pureFunctions,
  READ_ONLY_LIST_METHODS,
  returnsFreshFunctions,
  stateFreeFunctions,
  readNames,
  readsAny,
  readsState,
  rootName,
  volatileNames,
  writtenNames,
} from '@term/make/code/check/facts'
import {
  above,
  atLeast,
  atMost,
  below,
  linear,
  proves,
} from '@term/make/code/check/refine'
import {
  positiveEverywhere as sturmPositiveEverywhere,
  nonNegativeEverywhere as sturmNonNegativeEverywhere,
} from '@term/make/code/check/sturm'
import {
  bivariateNonNegative,
  type Bivariate,
} from '@term/make/code/check/cad'
import {
  nonNegativeEverywhereNvar,
  nPoly,
} from '@term/make/code/check/cad-nvar'

let modCounter = 0

// the extremum each name computes in the program being checked: the intrinsics `max` / `min` when the program does
// not define a task of that name, and any task whose whole body is `send back, call max (or min) a b` of its own two
// parameters in order. Set by checkHolds for each program.
let extrema = new Map<string, 'max' | 'min'>()

function extremumOf(name: string): 'max' | 'min' | undefined {
  return extrema.get(name)
}

function extremaOf(program: Program): Map<string, 'max' | 'min'> {
  const defined = new Map<string, Extract<Statement, { form: 'function' }>>()

  for (const statement of program) {
    if (statement.form === 'function') {
      defined.set(statement.name, statement)
    }
  }

  const table = new Map<string, 'max' | 'min'>()

  for (const intrinsic of ['max', 'min'] as const) {
    if (!defined.has(intrinsic)) {
      table.set(intrinsic, intrinsic)
    }
  }

  for (const [name, fn] of defined) {
    const only = fn.body.length === 1 ? fn.body[0] : undefined

    if (
      fn.params.length !== 2 ||
      only?.form !== 'return' ||
      only.value?.form !== 'call' ||
      only.value.callee.form !== 'variable' ||
      only.value.args.length !== 2
    ) {
      continue
    }

    const inner = table.get(only.value.callee.name)
    const [a, b] = only.value.args

    if (
      inner &&
      a?.form === 'variable' &&
      b?.form === 'variable' &&
      a.name === fn.params[0]!.name &&
      b.name === fn.params[1]!.name
    ) {
      table.set(name, inner)
    }
  }

  return table
}

// each remainder atom's dividend: a truncated remainder has the sign of its dividend, so where the dividend is
// provably non-negative the remainder is too
const modDividends = new Map<string, Linear>()

// the facts `m >= 0` for every remainder atom among these whose dividend the facts already show is non-negative
function signedRemainders(all: Inequality[]): Inequality[] {
  const extra: Inequality[] = []

  for (const q of all) {
    for (const key of q.linear.terms.keys()) {
      const dividend = modDividends.get(key)

      if (dividend && proves(all, atLeast(dividend, linear({}, 0)))) {
        extra.push(atLeast(linear({ [key]: 1 }), linear({}, 0)))
      }
    }
  }

  return extra
}

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

    // a list's length is an ATOM the prover may name, never negative: `xs/length`, and `size` / `array-size` of a
    // plain path, which the stdlib defines as it. Keyed `@length:<path>`, and forgotten with the path's root.
    case 'member':
    case 'call': {
      if (expr.form === 'call' && expr.callee.form === 'variable') {
        const name = expr.callee.name

        // the built-in `increment` / `decrement` (compile/surface.ts UNARY_BUILTIN) are x + 1 and x - 1
        if ((name === 'increment' || name === 'decrement') && expr.args.length === 1) {
          const inner = toLinear(expr.args[0]!, side)

          return inner
            ? add(inner, linear({}, name === 'increment' ? 1 : -1))
            : undefined
        }

        // `max a b` is at least each argument and `min a b` at most each. Read off the intrinsic, or off a task whose
        // whole body is that intrinsic applied to its own two parameters in order (the stdlib's `maximum` and
        // `minimum`), recognized by its SHAPE, never by its name, so a task of the same name that does something
        // else gets nothing (extremumOf)
        const extremum = extremumOf(name)

        if (extremum && expr.args.length === 2) {
          const a = toLinear(expr.args[0]!, side)
          const b = toLinear(expr.args[1]!, side)

          if (a && b) {
            const e = linear({ [`__ext${modCounter++}`]: 1 })

            if (extremum === 'max') {
              side.push(atLeast(e, a), atLeast(e, b))
            } else {
              side.push(atMost(e, a), atMost(e, b))
            }

            return e
          }
        }

        // `bitwise-and x k` with a constant mask 0 <= k < 2^31 lies in [0, k] for every x: the result has no bit k
        // does not have. Below 2^31 because JavaScript's `&` works on signed 32-bit integers, where a mask with the
        // top bit set can give a negative result.
        if (name === 'bitwise-and' && expr.args.length === 2) {
          const constant = (e: Expression): number | undefined => {
            const l = toLinear(e, [])

            return l ? constantOf(l) : undefined
          }
          const mask = constant(expr.args[1]!) ?? constant(expr.args[0]!)

          if (
            mask !== undefined &&
            Number.isInteger(mask) &&
            mask >= 0 &&
            mask < 2 ** 31
          ) {
            const bits = linear({ [`__and${modCounter++}`]: 1 })
            side.push(atLeast(bits, linear({}, 0)))
            side.push(atMost(bits, linear({}, mask)))

            return bits
          }
        }
      }

      const key = lengthAtom(expr)

      if (key === undefined) {
        return undefined
      }

      const atom = linear({ [key]: 1 })
      side.push(atLeast(atom, linear({}, 0)))

      return atom
    }

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
        // x mod k, for a positive integer constant k, is a fresh variable in [-(k-1), k-1]. NOT [0, k-1]: every
        // backend TRUNCATES (JavaScript, Rust, Swift and Kotlin all give -7 % 3 == -1), so the remainder takes the
        // sign of x. Until 2026-10-02 this said [0, k-1], and `n % 3 >= 0` was proven for an integer n that may be
        // negative (test/check/soundness.ts).
        const k = constantOf(right)

        if (k !== undefined && Number.isInteger(k) && k > 0) {
          const key = `__mod${modCounter++}`
          const m = linear({ [key]: 1 })
          // the dividend, so a goal can add `m >= 0` where the dividend is provably non-negative (signedRemainders)
          modDividends.set(key, left)
          side.push(atLeast(m, linear({}, -(k - 1)))) // m >= -(k-1)
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

// a plain path (`xs`, `self/line`) as dotted text, or undefined when any step is computed
function plainPath(expr: Expression): string | undefined {
  if (expr.form === 'variable') {
    return expr.name
  }

  if (expr.form === 'member' && !expr.index) {
    const inner = plainPath(expr.target)

    return inner === undefined ? undefined : `${inner}.${expr.name}`
  }

  return undefined
}

const LENGTH_CALLS = new Set(['size', 'array-size', 'list_size'])

// the atom key for a list length, or undefined when the expression is not one
function lengthAtom(expr: Expression): string | undefined {
  if (expr.form === 'member' && !expr.index && expr.name === 'length') {
    const path = plainPath(expr.target)

    return path === undefined ? undefined : `@length:${path}`
  }

  if (
    expr.form === 'call' &&
    expr.callee.form === 'variable' &&
    LENGTH_CALLS.has(expr.callee.name) &&
    expr.args.length === 1
  ) {
    const path = plainPath(expr.args[0]!)

    return path === undefined ? undefined : `@length:${path}`
  }

  return undefined
}

// the variable a fact key reads: itself for a plain name, the root of the path for a length atom
function keyRoot(key: string): string {
  return key.startsWith('@length:')
    ? key.slice('@length:'.length).split('.')[0]!
    : key
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
// The SIGN of an integer matrix's determinant, computed EXACTLY by Bareiss fraction-free elimination in BigInt, or
// NaN when an entry is not a safe integer (refused rather than rounded). Until 2026-10-02 this was a floating cofactor
// expansion rounded at the end, exact only while every product stayed under 2^53: with a = 2^30 - 1, b = 2^30,
// d = 2^30 + 1 the minor a·d - b² is -1 and came out 0, so `a x² + 2b xy + d y² >= 0` was PROVEN for a quadratic that
// is -1073741823 at x = 2^30, y = -(2^30 - 1) (test/check/soundness.ts). Every caller only compares the result with 0.
function determinant(matrix: number[][]): number {
  const n = matrix.length

  if (n === 0) {
    return 1
  }

  if (!matrix.every(row => row.every(v => Number.isSafeInteger(v)))) {
    return Number.NaN
  }

  const m = matrix.map(row => row.map(v => BigInt(v)))
  let sign = 1n
  let previous = 1n

  for (let k = 0; k < n - 1; k++) {
    if (m[k]![k] === 0n) {
      const swap = m.findIndex((row, r) => r > k && row[k] !== 0n)

      if (swap < 0) {
        return 0
      }

      ;[m[k], m[swap]] = [m[swap]!, m[k]!]
      sign = -sign
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        // exact: Bareiss's theorem says this division leaves no remainder
        m[i]![j] = (m[i]![j]! * m[k]![k]! - m[i]![k]! * m[k]![j]!) / previous
      }
    }

    previous = m[k]![k]!
  }

  const value = sign * m[n - 1]![n - 1]!

  return value > 0n ? 1 : value < 0n ? -1 : 0
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

    // NaN (an entry that is not a safe integer) is refused: `NaN < 0` is false, and it must not read as a pass
    const minor = determinant(submatrix(matrix, indices))

    if (Number.isNaN(minor) || minor < 0) {
      return false
    }
  }

  return true
}

// positive DEFINITE (Sylvester): every LEADING principal minor is > 0.
function isPositiveDefinite(matrix: number[][]): boolean {
  for (let k = 1; k <= matrix.length; k++) {
    const indices = Array.from({ length: k }, (_, i) => i)

    const minor = determinant(submatrix(matrix, indices))

    if (Number.isNaN(minor) || minor <= 0) {
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

// ===== general multivariate sum-of-squares (the nonlinear `nia` / SOS decision via a Gram matrix) =====
// p is a sum of squares (hence >= 0) iff p = z^T Q z for the monomial vector z and a PSD matrix Q. We search for such a
// Q over the NEWTON basis (the half of each even-exponent monomial of p) and -- crucially -- VERIFY the candidate: it
// is accepted only if Q is positive-semidefinite AND z^T Q z equals p exactly. So a wrong search NEVER yields a false
// positive (it can only miss an SOS). This catches the non-diagonal multivariate cases the perfect-square / diagonal
// tests miss, e.g. (a^2 - b^2)^2 written as a^4 + b^4 >= 2 a^2 b^2. The matrix M below is 2Q, kept integer.

// half of a monomial (each exponent halved), or null if any exponent is odd
function halfMonomial(key: string): string | null {
  const counts = new Map<string, number>()

  for (const v of monomialVars(key)) {
    counts.set(v, (counts.get(v) ?? 0) + 1)
  }

  const half: string[] = []

  for (const [v, c] of counts) {
    if (c % 2 !== 0) {
      return null
    }

    for (let i = 0; i < c / 2; i++) {
      half.push(v)
    }
  }

  return monomialKey(half)
}

const multiplyMonomial = (a: string, b: string): string =>
  monomialKey([...monomialVars(a), ...monomialVars(b)])

// the cartesian product of a list of option-lists (for the bounded ambiguous-monomial search)
function cartesian(lists: number[][]): number[][] {
  let out: number[][] = [[]]

  for (const list of lists) {
    const next: number[][] = []

    for (const prefix of out) {
      for (const item of list) {
        next.push([...prefix, item])
      }
    }

    out = next
  }

  return out
}

function multivariateSOS(poly: Poly): boolean {
  const p = new Map([...poly].filter(([, c]) => c !== 0))

  if (p.size === 0) {
    return true // 0 is a sum of squares
  }

  // the Newton basis: the half of each even-exponent monomial of p
  const basisSet = new Set<string>()

  for (const key of p.keys()) {
    const half = halfMonomial(key)

    if (half !== null) {
      basisSet.add(half)
    }
  }

  const basis = [...basisSet]
  const n = basis.length

  if (n === 0 || n > 8) {
    return false // empty or too large for the bounded search
  }

  // the basis pairs (i <= j) that produce each monomial
  const pairsFor = new Map<string, [number, number][]>()

  for (let i = 0; i < n; i++) {
    for (let j = i; j < n; j++) {
      const product = multiplyMonomial(basis[i]!, basis[j]!)
      const list = pairsFor.get(product) ?? []
      list.push([i, j])
      pairsFor.set(product, list)
    }
  }

  // every monomial of p must be representable by some pair
  for (const key of p.keys()) {
    if (!pairsFor.has(key)) {
      return false
    }
  }

  const ambiguous = [...p.keys()].filter(
    key => (pairsFor.get(key) ?? []).length > 1,
  )

  if (ambiguous.length > 3) {
    return false // bound the discrete search
  }

  // try assigning each ambiguous monomial's coefficient to one of its producing pairs (the determined ones use their
  // single pair). Build M = 2Q, then VERIFY identity + positive-semidefiniteness.
  for (const combo of cartesian(
    ambiguous.map(key => (pairsFor.get(key) ?? []).map((_, i) => i)),
  )) {
    const matrix = Array.from({ length: n }, () =>
      new Array<number>(n).fill(0),
    )

    for (const [key, coefficient] of p) {
      const pairs = pairsFor.get(key)!
      const [i, j] =
        pairs.length === 1
          ? pairs[0]!
          : pairs[combo[ambiguous.indexOf(key)]!]!

      if (i === j) {
        matrix[i]![i]! += 2 * coefficient
      } else {
        matrix[i]![j]! += coefficient
        matrix[j]![i]! += coefficient
      }
    }

    // VERIFY z^T M z == 2p exactly (every produced monomial matches): the soundness guarantee.
    const produced = new Map<string, number>()

    for (let i = 0; i < n; i++) {
      for (let j = i; j < n; j++) {
        const product = multiplyMonomial(basis[i]!, basis[j]!)
        const contribution = i === j ? matrix[i]![i]! : 2 * matrix[i]![j]!
        produced.set(product, (produced.get(product) ?? 0) + contribution)
      }
    }

    let identity = true

    for (const key of new Set([...produced.keys(), ...p.keys()])) {
      if ((produced.get(key) ?? 0) !== 2 * (p.get(key) ?? 0)) {
        identity = false
        break
      }
    }

    if (identity && isPositiveSemidefinite(matrix)) {
      return true
    }
  }

  return false
}

// a goal `L >= R` / `R <= L` whose difference is a sum of squares.
function sosProves(expr: Expression): boolean {
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

  return multivariateSOS(difference)
}

// ===== univariate real positivity via STURM (the one-dimensional CAD base case) =====

// the single-variable coefficient list of a polynomial (`coeff[power]`), or null if it mentions more than one variable.
// A monomial key is the variables joined by spaces, so its power is the number of parts and it is univariate when every
// part is the same variable.
function univariateCoefficients(poly: Poly): number[] | null {
  let only: string | null = null
  const byPower = new Map<number, number>()

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    const vars = monomialVars(key)

    for (const v of vars) {
      if (only === null) {
        only = v
      } else if (only !== v) {
        return null
      }
    }

    const power = vars.length
    byPower.set(power, (byPower.get(power) ?? 0) + coefficient)
  }

  let degree = 0

  for (const power of byPower.keys()) {
    degree = Math.max(degree, power)
  }

  const coefficients: number[] = new Array(degree + 1).fill(0)

  for (const [power, coefficient] of byPower) {
    coefficients[power] = coefficient
  }

  return coefficients
}

// a goal `L > R` / `R < L` (strict) or `L >= R` / `R <= L` (non-strict) whose UNIVARIATE difference `L - R` is strictly
// positive for all reals, decided exactly by Sturm's theorem (zero real roots and a positive sample). Strict positivity
// implies the non-strict goal too, so one test covers both. This reaches positivity the sum-of-squares and quadratic
// certificates miss -- e.g. `x^4 - 3x^2 + 3 > 0` (no real root, yet not a sum of square monomials) -- and is sound: a
// polynomial with a genuine real root has zero `realRootCount` only when it has none, so it is never falsely certified.
function sturmProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression
  let strict: boolean

  switch (expr.op) {
    case '>':
      upper = expr.left
      lower = expr.right
      strict = true
      break
    case '>=':
      upper = expr.left
      lower = expr.right
      strict = false
      break
    case '<':
      upper = expr.right
      lower = expr.left
      strict = true
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      strict = false
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  const coefficients = univariateCoefficients(difference)

  if (!coefficients) {
    return false
  }

  // a STRICT goal (`>` / `<`) needs the difference strictly positive for all reals; a NON-STRICT goal (`>=` / `<=`)
  // needs it non-negative everywhere, decided completely by the cell decomposition (so it also accepts the touching-zero
  // cases like `(x-1)^2 (x-2)^2 >= 0` that strict positivity cannot, while still rejecting any polynomial that dips
  // below zero).
  return strict
    ? sturmPositiveEverywhere(coefficients)
    : sturmNonNegativeEverywhere(coefficients)
}

// the bivariate coefficient table of a polynomial (`table[i][j]` = coefficient of `var0^i var1^j`), or null if it does
// not mention exactly two variables. A monomial key is the variables joined by spaces, so the power of each variable is
// the count of its occurrences.
function bivariateCoefficients(poly: Poly): Bivariate | null {
  const vars: string[] = []

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    for (const v of monomialVars(key)) {
      if (!vars.includes(v)) {
        vars.push(v)
      }
    }
  }

  if (vars.length !== 2) {
    return null
  }

  vars.sort()
  const [v0, v1] = vars as [string, string]
  const table: bigint[][] = []

  for (const [key, coefficient] of poly) {
    if (coefficient === 0) {
      continue
    }

    let i = 0
    let j = 0

    for (const v of monomialVars(key)) {
      if (v === v0) {
        i++
      } else {
        j++
      }
    }

    while (table.length <= i) {
      table.push([])
    }

    const row = table[i]!

    while (row.length <= j) {
      row.push(0n)
    }

    row[j] = (row[j] ?? 0n) + BigInt(Math.round(coefficient))
  }

  return table
}

// a NON-STRICT goal `L >= R` / `R <= L` whose two-variable difference `L - R` is non-negative for ALL real values,
// decided exactly by the bivariate cylindrical algebraic decomposition (`cad.ts`). This proves nonlinear positivity with
// NO sum-of-squares certificate -- including the Motzkin polynomial `x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1 >= 0`, which is
// non-negative yet provably not a sum of squares, so the SOS / quadratic-form routes cannot reach it. Strict goals are
// not handled here (the decision accepts the touching-zero cases, which are not strictly positive).
function bivariateProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression

  switch (expr.op) {
    case '>=':
      upper = expr.left
      lower = expr.right
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  const table = bivariateCoefficients(difference)

  if (!table) {
    return false
  }

  return bivariateNonNegative(table)
}

// a NON-STRICT goal `L >= R` / `R <= L` whose THREE-OR-MORE-variable difference is non-negative for all real values,
// decided by the recursive n-variable cylindrical algebraic decomposition (`cad-nvar.ts`). This reaches multivariate
// positivity with no sum-of-squares certificate -- including the trivariate Choi-Lam form. Gated to a modest variable
// count and total degree, since the projection cost grows with both; larger goals are left to the other routes.
function nvarProves(expr: Expression): boolean {
  if (expr.form !== 'binary') {
    return false
  }

  let upper: Expression
  let lower: Expression

  switch (expr.op) {
    case '>=':
      upper = expr.left
      lower = expr.right
      break
    case '<=':
      upper = expr.right
      lower = expr.left
      break
    default:
      return false
  }

  const high = expandPolynomial(upper)
  const low = expandPolynomial(lower)

  if (!high || !low) {
    return false
  }

  const difference: Poly = new Map(high)

  for (const [key, value] of low) {
    difference.set(key, (difference.get(key) ?? 0) - value)
  }

  // collect the distinct variables and the total degree
  const vars: string[] = []
  let totalDegree = 0

  for (const [key, coefficient] of difference) {
    if (coefficient === 0) {
      continue
    }

    const monomial = monomialVars(key)
    totalDegree = Math.max(totalDegree, monomial.length)

    for (const v of monomial) {
      if (!vars.includes(v)) {
        vars.push(v)
      }
    }
  }

  // bound the work: 3 to 4 variables, total degree up to 6 (covers Choi-Lam); anything larger is left unproven here
  if (vars.length < 3 || vars.length > 4 || totalDegree > 6) {
    return false
  }

  vars.sort()
  const index = new Map(vars.map((v, i) => [v, i]))
  const terms: [number[], bigint][] = []

  for (const [key, coefficient] of difference) {
    if (coefficient === 0) {
      continue
    }

    const exps = new Array(vars.length).fill(0)

    for (const v of monomialVars(key)) {
      exps[index.get(v)!]++
    }

    terms.push([exps, BigInt(Math.round(coefficient))])
  }

  return nonNegativeEverywhereNvar(nPoly(terms), vars.length)
}

function nonlinearProves(expr: Expression): boolean {
  return (
    positivityProves(expr) ||
    quadraticProves(expr) ||
    perfectSquareProves(expr) ||
    sosProves(expr) ||
    sturmProves(expr) ||
    bivariateProves(expr) ||
    nvarProves(expr)
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

  const facts = [...available, ...side]
  const all = [...facts, ...signedRemainders(facts)]

  return goals.every(goal => proves(all, goal))
}

// a condition used as a path assumption: the inequalities it contributes, optionally negated (for an else branch).
// Conjunctions (&&) contribute both sides; anything outside the linear fragment contributes nothing (sound).
function assumptionInequalities(
  expr: Expression,
  negated: boolean,
  side: Inequality[],
): Inequality[] {
  // `!c` assumes the negation of c, and the negation of `!c` is c. This is how the condition of a finished walk
  // reaches what follows it (check/contract.ts).
  if (expr.form === 'unary' && expr.op === '!') {
    return assumptionInequalities(expr.operand, !negated, side)
  }

  if (expr.form !== 'binary') {
    return []
  }

  if (expr.op === '&&' && !negated) {
    return [
      ...assumptionInequalities(expr.left, false, side),
      ...assumptionInequalities(expr.right, false, side),
    ]
  }

  // not (a or b) is (not a) and (not b)
  if (expr.op === '||' && negated) {
    return [
      ...assumptionInequalities(expr.left, true, side),
      ...assumptionInequalities(expr.right, true, side),
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
  options: {
    originOnly?: boolean
    tally?: Tally
    only?: Set<string>
    // tasks NOT to walk here, because another pass checks them (compile.ts: the file's own tasks, in the copy)
    skip?: Set<string>
    // the pure tasks, when the caller already knows them (the checker's copy has the real program's answer)
    pure?: Set<string>
    // and the state-free ones, likewise
    stateFree?: Set<string>
    // and the length-keeping ones, and the ones that hand back a list they made
    keeping?: Set<string>
    returning?: Set<string>
  } = {},
): Diagnostic[] {
  const diagnostics: Diagnostic[] = []
  const pure = options.pure ?? pureFunctions(program)
  const stateFree = options.stateFree ?? stateFreeFunctions(program)
  const keeping = options.keeping ?? lengthKeepingFunctions(program)
  const returning = options.returning ?? returnsFreshFunctions(program)
  const functions = functionNames(program)
  const tables = constantTableLengths(program, pure)
  extrema = extremaOf(program)
  const globals = new Set(
    program.flatMap(s => (s.form === 'let' ? [s.name] : [])),
  )

  for (const statement of program) {
    if (
      statement.form === 'function' &&
      (!options.only || options.only.has(statement.name)) &&
      !options.skip?.has(statement.name)
    ) {
      // base assumptions from parameter refinements: a natural-number parameter is >= 0. And the lengths of the
      // constant tables, unless a parameter shadows one.
      const shadowed = new Set(statement.params.map(p => p.name))
      const base = [
        ...statement.params
          .filter(p => p.refine === 'natural')
          .map(p => atLeast(linear({ [p.name]: 1 }), linear({}, 0))),
        ...tables.filter(
          q => ![...q.linear.terms.keys()].some(k => shadowed.has(keyRoot(k))),
        ),
      ]

      walkHolds(statement.body, base, {
        diagnostics,
        file,
        pure,
        functions,
        local: localNames(statement),
        volatile: volatileNames(statement.body),
        originOnly: options.originOnly,
        tally: options.tally,
        globals,
        stateFree,
        keeping,
        fresh: freshNames(statement, returning),
        returning,
        scalars: scalarLocals(statement.body, statement.params),
        task: statement.method
          ? `${statement.method.form}/${statement.method.name}`
          : statement.name,
      })
    } else if (statement.form === 'hold' && !options.only) {
      // (a pass limited to some tasks leaves the module-level holds to the pass over the whole program)
      // a top-level `hold` declared at module scope: prove it with no assumptions (it has no enclosing parameters).
      // This is what lets a value-arithmetic obligation at the top level (e.g. `add 3 3 == 6`) be discharged by the
      // linear prover, the same as one inside a function body. The kernel pass (elaborate) handles the definitional
      // fragment and records its discharges, which the caller drops from these diagnostics.
      walkHolds([statement], [], {
        diagnostics,
        file,
        pure,
        functions,
        local: new Set(),
        volatile: new Set(),
        originOnly: options.originOnly,
        globals,
        stateFree,
        keeping,
      })
    }
  }

  return diagnostics
}

// what a walk needs besides its assumptions: where to report, which tasks are pure, which names the enclosing task
// binds itself, and which names a closure may write behind the walk's back (facts about those are never kept)
type Walk = {
  diagnostics: Diagnostic[]
  file: string
  pure: Set<string>
  functions: Set<string>
  local: Set<string>
  volatile: Set<string>
  // report only the holds the checker wrote (an `origin`), in its copy of the program
  originOnly?: boolean
  // where tier-0 obligations are counted, instead of being reported as errors
  tally?: Tally
  // the task being walked, for naming a tier-0 failure
  task?: string
  // module-level bindings, and the tasks that touch no Term state (facts.ts stateFreeFunctions)
  globals: Set<string>
  stateFree: Set<string>
  // the tasks that change no list's length anywhere (facts.ts lengthKeepingFunctions)
  keeping: Set<string>
  // the task's names bound only to fresh lists and maps (facts.ts freshNames): two of them never hold one list
  fresh?: Set<string>
  // the tasks that hand back only a list they made (facts.ts returnsFreshFunctions)
  returning?: Set<string>
  // the task's locals that only ever hold scalars (scalarLocals)
  scalars?: Set<string>
}

// the tier-0 count for one compile: how many obligations, how many proven, and the ones that were not, each with
// the task it is in and what it was owed for, which is how a baseline names it without a line number
export type Tally = {
  total: number
  proven: number
  // `ordinal` counts EVERY obligation of that kind in that task, proven or not, in the order they are met. A count
  // of failures alone renumbered every later one when an earlier one became proven, and a baseline keyed on it
  // churned with no change to the code it named.
  failed: {
    task: string
    origin: HoldOrigin
    ordinal: number
    diagnostic: Diagnostic
  }[]
  // the running count per `<task> <kind>`, for the ordinal
  seen?: Map<string, number>
}

// what a checker-written hold was owed for, as the start of its failure message
const OWED: Record<HoldOrigin, string> = {
  must: "this task's `must` is not proven where it sends back",
  need: "the called task's `have` is not proven at this call",
  'keep-entry': "this walk's `must` is not proven before the walk",
  'keep-turn': "this walk's `must` is not proven at the end of a turn",
  down: 'this `down` measure is not shown to stay a natural number and fall',
  index: 'this read is not shown to be inside the list',
  zero: 'this division is not shown to be by something other than zero',
  ends: 'this walk is not shown to end (give it a `down` measure, or note why it runs forever)',
  given: 'a promised fact',
}

// forget these names: their values changed, so a fact about the old value is no longer a fact. But what the facts
// said about OTHER names through them still holds, so each name is PROJECTED out (Fourier-Motzkin: every upper bound
// on it added to every lower bound, which cancels it) rather than its facts dropped. `len - i == 0` and `i == 25`
// leave `len == 25` when `i` is reset, where dropping them left nothing. Over the rationals the projection is exactly
// "some old value existed", so it is sound for integers too; it only gives up the integer tightening. A projection
// that would make too many rows falls back to dropping, which is weaker and still sound. A write whose root has no
// name (EVERYTHING) drops them all.
function forget(current: Inequality[], names: Set<string>): Inequality[] {
  if (names.size === 0) {
    return current
  }

  if (names.has(EVERYTHING)) {
    return []
  }

  let facts = current
  const keys = new Set<string>()

  for (const q of current) {
    for (const key of q.linear.terms.keys()) {
      if (names.has(keyRoot(key))) {
        keys.add(key)
      }
    }
  }

  for (const key of keys) {
    facts = eliminate(facts, key)
  }

  return facts
}

// the most rows one elimination may produce before it gives up and drops instead
const MAX_PROJECTED = 200

// Fourier-Motzkin elimination of one atom: the facts that do not mention it, and every sum of an upper and a lower
// bound on it scaled so it cancels
function eliminate(facts: Inequality[], key: string): Inequality[] {
  const kept: Inequality[] = []
  const upper: Inequality[] = []
  const lower: Inequality[] = []

  for (const q of facts) {
    const c = q.linear.terms.get(key) ?? 0

    if (c > 0) {
      upper.push(q)
    } else if (c < 0) {
      lower.push(q)
    } else {
      kept.push(q)
    }
  }

  if (upper.length * lower.length > MAX_PROJECTED) {
    return kept
  }

  const seen = new Set(kept.map(rowKey))

  for (const u of upper) {
    for (const l of lower) {
      const a = u.linear.terms.get(key)!
      const b = -l.linear.terms.get(key)!
      // b*u + a*l: the key's coefficients are a*b and -b*a
      const sum = add(scale(u.linear, b), scale(l.linear, a))
      sum.terms.delete(key)

      for (const [k, v] of [...sum.terms]) {
        if (v === 0) {
          sum.terms.delete(k)
        }
      }

      const row: Inequality = { linear: sum, strict: u.strict || l.strict }

      // a row with no atoms is either always true (drop it) or a contradiction the path already carried (keep it)
      if (sum.terms.size === 0 && (sum.constant < 0 || (sum.constant === 0 && !row.strict))) {
        continue
      }

      const id = rowKey(row)

      if (!seen.has(id)) {
        seen.add(id)
        kept.push(row)
      }
    }
  }

  return kept
}

function rowKey(q: Inequality): string {
  const terms = [...q.linear.terms].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))

  return `${terms.map(([k, v]) => `${v}*${k}`).join('+')}${q.strict ? '<' : '<='}${-q.linear.constant}`
}

// A WALK THAT ONLY COUNTS UP. Before a loop, every fact about a name its body writes is dropped, because a later
// turn sees a value an earlier turn wrote. That throws away `i >= 0` for a counter that only ever grows, which is
// exactly the fact every index into a list needs. So: when every write to x in the body is `x = x + c` (or
// `x += c`) for a constant c >= 0, a LOWER bound on x stays true however many turns run, and is kept. Counting down
// keeps an upper bound the same way. A fact keeps only if every written name in it moves the way that preserves it.
// Inequalities are `L <= 0` (or `< 0`): a coefficient below zero on x is a lower bound on x, above zero an upper one.
function keepAcrossTurns(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  return [
    ...keepMonotone(current, body, walk),
    ...relationalInvariants(current, body, walk),
  ]
}

// RELATIONS THAT NO TURN CHANGES. When every turn runs the whole body (no `turn next`, `halt`, `send back` or raise
// anywhere in it) and each of two names moves by a FIXED amount per turn (written only at the top level of the
// body, by `x = x + c`, or a list grown only by top-level pushes), then `dy*x - dx*y` is the same at the top of
// every turn and after the walk. Its value is read off the facts at entry, when both are known exactly. This is the
// counter and the list it fills, stepping together: `i` and `rk/length` both +1 a turn give `length - i == c`.
function relationalInvariants(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  if (exitsEarly(body)) {
    return []
  }

  const deltas = exactDeltas(body, walk)

  if (deltas.size < 2) {
    return []
  }

  const known = new Map<string, number>()

  for (const key of deltas.keys()) {
    const value = exactValue(current, key)

    if (value !== undefined) {
      known.set(key, value)
    }
  }

  const keys = [...known.keys()]
  const out: Inequality[] = []

  for (let a = 0; a < keys.length; a++) {
    for (let b = a + 1; b < keys.length; b++) {
      const x = keys[a]!
      const y = keys[b]!
      const dx = deltas.get(x)!
      const dy = deltas.get(y)!

      if (dx === 0 && dy === 0) {
        continue
      }

      // dy*x - dx*y never changes, and at entry it is dy*x0 - dx*y0
      const combination = linear({ [x]: dy, [y]: -dx })
      const value = linear({}, dy * known.get(x)! - dx * known.get(y)!)
      out.push(atMost(combination, value), atLeast(combination, value))
    }
  }

  return out
}

// THE COUNTER'S CEILING. A walk `while x < e` (or `x <= e`) whose body moves x by exactly +1 per turn and changes
// nothing e reads keeps `x <= e` (resp. `x <= e + 1`) at the top of every turn and after the walk, provided it held on
// entry: a turn starts with x < e and ends one higher. With the negated condition after the walk, that pins
// x == e, which is what lets a list filled to the count be known exactly and a second walk build on it.
function boundInvariant(
  current: Inequality[],
  statement: Extract<Statement, { form: 'while' }>,
  walk: Walk,
): Inequality[] {
  const cond = statement.cond

  if (
    cond.form !== 'binary' ||
    (cond.op !== '<' && cond.op !== '<=') ||
    exitsEarly(statement.body)
  ) {
    return []
  }

  const left = toLinear(cond.left, [])
  const right = toLinear(cond.right, [])

  if (!left || !right || left.terms.size !== 1) {
    return []
  }

  const [name, coefficient] = [...left.terms][0]!

  if (coefficient !== 1 || exactDeltas(statement.body, walk).get(name) !== 1) {
    return []
  }

  // e must not move: nothing the body writes appears in it
  const written = writtenNames(statement.body)

  for (const key of right.terms.keys()) {
    if (written.has(keyRoot(key)) || key.startsWith('@')) {
      return []
    }
  }

  // x <= e  (or x <= e + 1 for `<=`), as  x - e - c <= 0
  const ceiling = cond.op === '<' ? right : add(right, linear({}, 1))
  const fact = atMost(left, ceiling)

  return proves(current, fact) ? [fact] : []
}

// does a body leave a turn before its end, anywhere in it (a nested walk's own `halt` included, conservatively)
function exitsEarly(body: Statement[]): boolean {
  let found = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !found) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      continue
    }

    if (
      record.form === 'break' ||
      record.form === 'continue' ||
      record.form === 'return' ||
      record.form === 'throw' ||
      record.form === 'exit'
    ) {
      found = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return found
}

// the fixed per-turn change of every name the body writes ONLY at its top level by a constant step, and of every
// list it grows ONLY by top-level pushes. A name or list touched anywhere else gets no entry.
function exactDeltas(
  body: Statement[],
  walk: Walk,
): Map<string, number> {
  const deltas = new Map<string, number>()
  const disqualified = new Set<string>()
  // names the body has just set to a constant, at its top level, with nothing writing them since
  const reset = new Map<string, number>()
  // pushes made inside nested counted walks whose growth is already in `deltas`
  let countedPushes = 0

  for (const statement of body) {
    if (statement.form === 'assign' && statement.target.form === 'variable') {
      const name = statement.target.name
      const step = stepOf(name, statement)
      const constant =
        statement.op === '=' ? constantOfExpression(statement.value) : undefined

      reset.delete(name)

      if (constant !== undefined && !walk.volatile.has(name)) {
        reset.set(name, constant)
      }

      if (step === undefined || walk.volatile.has(name)) {
        disqualified.add(name)
      } else {
        deltas.set(name, (deltas.get(name) ?? 0) + step)
      }

      continue
    }

    // a binding made afresh each turn is no step, but a constant one is a reset a nested walk can count from
    if (statement.form === 'let') {
      const constant = constantOfExpression(statement.init)

      disqualified.add(statement.name)
      reset.delete(statement.name)

      if (constant !== undefined && !walk.volatile.has(statement.name)) {
        reset.set(statement.name, constant)
      }

      continue
    }

    const pushed = pushedPath(statement, walk)

    if (pushed !== undefined) {
      const key = `@length:${pushed}`
      deltas.set(key, (deltas.get(key) ?? 0) + 1)
      continue
    }

    // A NESTED COUNTED WALK. `r = r0` just before, then `walk while r < K` with K a constant, r moving by exactly +1
    // a turn and the inner body leaving no turn early: it runs K - r0 turns every time, so whatever moves by a fixed
    // step per inner turn moves by that step times K - r0 per outer turn. This is the 4 x 4 walk that fills a block.
    const nested = statement.form === 'while' ? countedTurns(statement, reset, walk) : undefined

    if (nested !== undefined) {
      for (const [key, step] of nested.deltas) {
        if (key === nested.counter) {
          continue
        }

        deltas.set(key, (deltas.get(key) ?? 0) + step * nested.turns)
      }

      countedPushes += nested.pushes

      // the counter ends at K, which is a reset, not a step
      disqualified.add(nested.counter)
      reset.set(nested.counter, nested.turns + reset.get(nested.counter)!)

      for (const name of writtenNames(statement)) {
        if (!nested.deltas.has(name)) {
          disqualified.add(name)
          reset.delete(name)
        }
      }

      continue
    }

    for (const name of writtenNames(statement)) {
      reset.delete(name)
    }

    // any other statement: whatever it writes, nested, is not a fixed step
    for (const name of writtenNames(statement)) {
      disqualified.add(name)
    }
  }

  // a list touched by anything but those pushes (a nested push, an impure call, a member write) has no fixed step
  const allPushes = bodyOnlyPushes(body, walk)
  const otherState = allPushes === false || writesThroughMember(body)
  const topPushes =
    body.filter(s => pushedPath(s, walk) !== undefined).length + countedPushes
  // a push somewhere below the top level runs on some turns and not others
  const nestedPushes = allPushes !== false && allPushes !== topPushes

  for (const key of [...deltas.keys()]) {
    if (disqualified.has(key)) {
      deltas.delete(key)
    } else if (key.startsWith('@') && (otherState || nestedPushes)) {
      deltas.delete(key)
    }
  }

  return deltas
}

// the integer an expression always is, when it reads nothing (`code 0`, `call add(code 2, code 2)`)
function constantOfExpression(expr: Expression): number | undefined {
  const side: Inequality[] = []
  const value = toLinear(expr, side)

  return value && side.length === 0 && value.terms.size === 0 && Number.isInteger(value.constant)
    ? value.constant
    : undefined
}

// how many turns a walk `while r < K` (or `r <= K`) takes when r was just reset to a constant, K is a constant, r
// moves by exactly +1 a turn and no turn ends early, with the fixed per-turn steps of its body and the pushes they
// account for. Undefined for any walk not of that shape, or one whose pushes are not all fixed steps.
function countedTurns(
  statement: Extract<Statement, { form: 'while' }>,
  reset: Map<string, number>,
  walk: Walk,
): { counter: string; turns: number; deltas: Map<string, number>; pushes: number } | undefined {
  const cond = statement.cond

  if (
    cond.form !== 'binary' ||
    (cond.op !== '<' && cond.op !== '<=') ||
    cond.left.form !== 'variable' ||
    exitsEarly(statement.body) ||
    callsImpure(cond, walk.pure, walk.functions, walk.local)
  ) {
    return undefined
  }

  const counter = cond.left.name
  const start = reset.get(counter)
  const limit = constantOfExpression(cond.right)

  if (start === undefined || limit === undefined || walk.volatile.has(counter)) {
    return undefined
  }

  const deltas = exactDeltas(statement.body, walk)

  if (deltas.get(counter) !== 1) {
    return undefined
  }

  const pushes = bodyOnlyPushes(statement.body, walk)

  if (pushes === false) {
    return undefined
  }

  // every push in the body must be a fixed step, or the lengths it grows are not known
  if (pushes > 0 && ![...deltas.keys()].some(key => key.startsWith('@'))) {
    return undefined
  }

  const turns = Math.max(0, (cond.op === '<' ? limit : limit + 1) - start)

  return { counter, turns, deltas, pushes }
}

// the constant a key equals in these facts, when they pin it: some fact bounds it above and some below by the same
// constant, and the prover confirms both
function exactValue(facts: Inequality[], key: string): number | undefined {
  const atom = linear({ [key]: 1 })
  const pinned = (candidate: number): boolean =>
    Number.isInteger(candidate) &&
    proves(facts, atMost(atom, linear({}, candidate))) &&
    proves(facts, atLeast(atom, linear({}, candidate)))

  // a value pinned only THROUGH other facts (`length - i == 0` and `i == 16`) has no fact of its own to read, so the
  // constants the facts mention are tried as candidates, each confirmed by the prover
  const candidates = new Set<number>([0])

  for (const q of facts) {
    candidates.add(q.linear.constant)
    candidates.add(-q.linear.constant)
  }

  for (const candidate of candidates) {
    if (pinned(candidate)) {
      return candidate
    }
  }

  for (const q of facts) {
    if (q.linear.terms.size !== 1 || q.strict) {
      continue
    }

    const coefficient = q.linear.terms.get(key)

    if (coefficient === undefined || Math.abs(coefficient) !== 1) {
      continue
    }

    // `c*key + k <= 0` gives the candidate key = -k/c
    const candidate = -q.linear.constant / coefficient
    const atom = linear({ [key]: 1 })
    const value = linear({}, candidate)

    if (
      Number.isInteger(candidate) &&
      proves(facts, atMost(atom, value)) &&
      proves(facts, atLeast(atom, value))
    ) {
      return candidate
    }
  }

  return undefined
}

function keepMonotone(
  current: Inequality[],
  body: Statement[],
  walk: Walk,
): Inequality[] {
  const written = writtenNames(body)

  if (written.has(EVERYTHING)) {
    return []
  }

  const direction = new Map<string, 'up' | 'down' | 'any'>()

  for (const name of written) {
    direction.set(name, walk.volatile.has(name) ? 'any' : directionOf(name, body))
  }

  // STATE ACROSS TURNS. A later turn sees every list an earlier turn changed. When the body only ever PUSHES (with
  // pure arguments), lengths only grow, so a LOWER bound on a length survives every turn and anything else about a
  // length does not. Any other impure call, or any write through a member, and no length fact survives at all.
  const pushes = bodyOnlyPushes(body, walk)
  const changesState =
    pushes === false ||
    pushes > 0 ||
    writesThroughMember(body)

  // any impure call at all may change a list that is not local to this task, so no such length survives a turn,
  // unless every one is a call that changes no length (keepsLengths)
  if (
    callsImpure(body, walk.pure, walk.functions, walk.local) &&
    !onlyKeepsLengths(body, walk)
  ) {
    current = current.filter(q => {
      for (const key of q.linear.terms.keys()) {
        if (key.startsWith('@') && !walk.local.has(keyRoot(key))) {
          return false
        }
      }

      return true
    })
  }

  if (changesState) {
    current = current.filter(q => {
      for (const [key, coefficient] of q.linear.terms) {
        if (!key.startsWith('@')) {
          continue
        }

        if (pushes === false || writesThroughMember(body) || coefficient >= 0) {
          return false
        }
      }

      return true
    })
  }

  return current.filter(q => {
    for (const [key, coefficient] of q.linear.terms) {
      const way = direction.get(keyRoot(key))

      if (way === undefined) {
        continue
      }

      // a length atom moves with whatever the body does to its list, which this does not track
      if (key.startsWith('@')) {
        return false
      }

      if (way === 'any') {
        return false
      }

      if (way === 'up' && coefficient >= 0) {
        return false
      }

      if (way === 'down' && coefficient <= 0) {
        return false
      }
    }

    return true
  })
}

// how a body moves a name: 'up' when every write is an increment by a constant >= 0, 'down' for decrements, 'any'
// otherwise (a rebinding, a computed step, a write inside a closure, a member write)
function directionOf(name: string, body: Statement[]): 'up' | 'down' | 'any' {
  let ups = 0
  let downs = 0
  let other = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      if (writtenNames(record.body).has(name)) {
        other = true
      }

      continue
    }

    if (record.form === 'let' && record.name === name) {
      other = true
    }

    if (record.form === 'for-each' && (record.item === name || record.index === name)) {
      other = true
    }

    if (record.form === 'assign') {
      const statement = record as Extract<Statement, { form: 'assign' }>

      if (rootName(statement.target) === name || rootName(statement.target) === undefined) {
        const step = stepOf(name, statement)

        if (step === undefined || statement.target.form !== 'variable') {
          other = true
        } else if (step >= 0) {
          ups++
        } else {
          downs++
        }
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  if (other) {
    return 'any'
  }

  if (downs === 0) {
    return 'up'
  }

  if (ups === 0) {
    return 'down'
  }

  return 'any'
}

// the constant an assignment adds to a name (`x = x + 2` is 2, `x -= 1` is -1), or undefined when it is not one
function stepOf(
  name: string,
  statement: Extract<Statement, { form: 'assign' }>,
): number | undefined {
  const side: Inequality[] = []
  const value = toLinear(statement.value, side)

  if (!value || side.length > 0) {
    return undefined
  }

  if (statement.op === '=') {
    if ((value.terms.get(name) ?? 0) !== 1 || value.terms.size !== 1) {
      return undefined
    }

    return value.constant
  }

  if (statement.op === '+=' || statement.op === '-=') {
    if (value.terms.size !== 0) {
      return undefined
    }

    return statement.op === '+=' ? value.constant : -value.constant
  }

  return undefined
}

// the equality a binding or an assignment `x = e` contributes, or nothing when it is not a stable fact: `e` reads `x`
// itself (the old value, which is now gone), or `x` is volatile. State is safe here because `toLinear` reads no state
// but a list's length, which is an atom forgotten with its list and after every impure call.
function definingEqualities(
  name: string,
  value: Expression,
  walk: Walk,
): Inequality[] {
  if (
    walk.volatile.has(name) ||
    readNames(value).has(name) ||
    readsAny(value, walk.volatile)
  ) {
    return []
  }

  // a list literal: its length is the number of items written, a fact about the atom `@length:name`, which every
  // write through a member and every impure call forgets
  if (value.form === 'array') {
    return literalLength(name, value.items.length)
  }

  // `x = y` with y a list: the two names hold ONE list, so their lengths are equal. Sound under every later change:
  // a push to either rewrites that one's length and forgets every other length fact, this one included
  if (value.form === 'variable' && value.type?.kind === 'array') {
    const same = linear({ [`@length:${name}`]: 1, [`@length:${value.name}`]: -1 })

    return [atMost(same, linear({}, 0)), atLeast(same, linear({}, 0))]
  }

  const side: Inequality[] = []
  const equalities = bindingEqualities(name, value, side)

  return [...side, ...equalities]
}

// walk a body in order, threading the path assumptions: branch conditions refine their branches, the else branch
// assumes the negation, and a binding or assignment contributes its defining equality to what follows. Every write
// first drops the facts about the name it writes, and every compound statement drops, afterwards, the facts about
// every name its bodies may have written. A loop drops them BEFORE its body too, because a later turn sees values an
// earlier turn wrote.
function walkHolds(
  body: Statement[],
  assumptions: Inequality[],
  walk: Walk,
): void {
  const { diagnostics, file } = walk
  let current = forget(assumptions, walk.volatile)

  for (const statement of body) {
    switch (statement.form) {
      case 'hold': {
        // a callee's `must`, assumed where the call returns (check/contract.ts promisedBy): it is proven where the
        // callee is checked, so here it is a fact, in line, and the statements after it keep their place in the body
        if (statement.origin === 'given') {
          if (!callsImpure(statement.expr, walk.pure, walk.functions, walk.local)) {
            const side: Inequality[] = []
            const facts = assumptionInequalities(statement.expr, false, side)
            current = [...current, ...side, ...facts]
          }

          break
        }

        // in a pass over the checker's copy (check/contract.ts), a hold the programmer wrote was already checked in
        // the real program, and only the ones the checker wrote are this pass's to report
        if (walk.originOnly && !statement.origin) {
          break
        }

        // a goal that calls something two calls may disagree on cannot be decided by any prover here: the linear
        // and polynomial engines read a call as an atom, and an atom is equal to itself
        const verdict = callsImpure(
          statement.expr,
          walk.pure,
          walk.functions,
          walk.local,
        )
          ? null
          : goalProvable(statement.expr, current)

        const owed = statement.origin ? OWED[statement.origin] : undefined
        // a tier-0 obligation is COUNTED, not failed: nobody wrote it, so the gate holds it to a baseline (term
        // hold) rather than the build refusing code that was fine yesterday. note/term/proof-by-default/obligations.md
        const tier0 =
          statement.origin === 'index' ||
          statement.origin === 'zero' ||
          statement.origin === 'ends'
        let ordinal = 0

        if (tier0 && walk.tally) {
          walk.tally.seen ??= new Map()
          const kind = `${walk.task ?? ''} ${statement.origin}`
          ordinal = walk.tally.seen.get(kind) ?? 0
          walk.tally.seen.set(kind, ordinal + 1)
        }

        const report: { push: (d: Diagnostic) => void } =
          tier0 && walk.tally
            ? {
                push: d =>
                  walk.tally!.failed.push({
                    task: walk.task ?? '',
                    origin: statement.origin!,
                    ordinal,
                    diagnostic: d,
                  }),
              }
            : diagnostics

        if (tier0 && walk.tally) {
          walk.tally.total++
        }

        if (verdict === true && tier0 && walk.tally) {
          walk.tally.proven++
        }

        if (verdict === null) {
          report.push(
            diagnose('unchecked-hold', {
              file,
              span: statement.span,
              message: owed
                ? `${owed}, and it is outside what the provers decide`
                : 'this hold is outside the decidable linear fragment and was not proven',
            }),
          )
        } else if (verdict === false) {
          report.push(
            diagnose('unproven', {
              file,
              span: statement.span,
              message: owed
                ? `${owed}: it does not follow from what is known here`
                : 'this hold could not be proven from the available assumptions',
            }),
          )
        }

        break
      }

      case 'let':
        // a binding, `host` or `save`, is a new value under its name: the old facts go, the defining equality comes.
        // A `save` binding used to contribute nothing, because nothing retracted it when it was reassigned. Now the
        // assignment below retracts it, so it may.
        current = [
          ...forget(current, new Set([statement.name])),
          ...definingEqualities(statement.name, statement.init, walk),
        ]
        holdsInExpression(statement.init, walk)
        break

      case 'assign': {
        const root = rootName(statement.target) ?? EVERYTHING
        // `x = x + c` (or `x += c`) does not lose what was known about x: the old value is the new one less c, so
        // every fact about the old value is rewritten as a fact about the new one. This is what a fresh name per
        // assignment gives for free, and it is what lets a walk's `down` measure be shown to fall.
        const shifted =
          statement.target.form === 'variable'
            ? shiftFacts(current, root, statement, walk)
            : undefined

        current = shifted ?? forget(current, new Set([root]))

        // a write through a member may land in a list another name also holds, and a write past the end grows it,
        // so no length is known after one
        if (statement.target.form === 'member') {
          current = current.filter(q => !mentionsAtom(q))
        }

        // a plain `x = e` (not `x += e`, not a member write) is the same kind of fact a binding is
        if (
          shifted === undefined &&
          statement.op === '=' &&
          statement.target.form === 'variable'
        ) {
          current = [
            ...current,
            ...definingEqualities(root, statement.value, walk),
          ]
        }

        holdsInExpression(statement.value, walk)
        break
      }

      case 'expression':
        holdsInExpression(statement.expr, walk)
        break

      case 'return':
        if (statement.value) {
          holdsInExpression(statement.value, walk)
        }

        break

      case 'if': {
        const negations: Inequality[] = []

        for (const branch of statement.branches) {
          const side: Inequality[] = []
          const conditions = callsImpure(
            branch.cond,
            walk.pure,
            walk.functions,
            walk.local,
          )
            ? []
            : assumptionInequalities(branch.cond, false, side)

          walkHolds(
            branch.body,
            [...current, ...negations, ...side, ...conditions],
            walk,
          )

          if (
            !callsImpure(
              branch.cond,
              walk.pure,
              walk.functions,
              walk.local,
            )
          ) {
            negations.push(
              ...assumptionInequalities(branch.cond, true, []),
            )
          }
        }

        if (statement.otherwise) {
          walkHolds(statement.otherwise, [...current, ...negations], walk)
        }

        current = forget(current, writtenNames(statement))
        break
      }

      case 'while': {
        // the loop body runs only when the condition holds, about the values at the top of THIS turn: a fact from
        // before the loop about a name the body writes is not true on the second turn, unless the body only ever
        // moves that name the way that keeps the fact (keepAcrossTurns)
        const before = [
          ...keepAcrossTurns(current, statement.body, walk),
          ...boundInvariant(current, statement, walk),
        ]
        const side: Inequality[] = []
        const conditions = callsImpure(
          statement.cond,
          walk.pure,
          walk.functions,
          walk.local,
        )
          ? []
          : assumptionInequalities(statement.cond, false, side)

        walkHolds(statement.body, [...before, ...side, ...conditions], walk)

        // a walk that never leaves a turn early ends only when its condition is false, so that is a fact after it
        const ended =
          !exitsEarly(statement.body) &&
          !callsImpure(
            statement.cond,
            walk.pure,
            walk.functions,
            walk.local,
          )
            ? assumptionInequalities(statement.cond, true, [])
            : []

        current = [...before, ...ended]
        break
      }

      case 'for-each': {
        const before = forget(
          keepAcrossTurns(current, statement.body, walk),
          new Set([statement.item, ...(statement.index ? [statement.index] : [])]),
        )

        walkHolds(statement.body, before, walk)
        current = before
        break
      }

      case 'match':
        for (const branch of statement.cases) {
          walkHolds(
            branch.body,
            forget(current, new Set(branch.binds ?? [])),
            walk,
          )
        }

        if (statement.otherwise) {
          walkHolds(statement.otherwise, current, walk)
        }

        current = forget(current, writtenNames(statement))
        break

      case 'guard': {
        // the body may stop at any statement and land in the handler, so the handler knows only what was true
        // before the body began, less whatever the body may have written
        walkHolds(statement.body, current, walk)

        const after = forget(current, writtenNames(statement.body))

        if (statement.catch) {
          walkHolds(
            statement.catch.body,
            forget(after, new Set([statement.catch.name])),
            walk,
          )
        }

        current = forget(current, writtenNames(statement))
        break
      }

      case 'function':
        // a nested task is its own scope: its holds are checked from its own parameters, never from the facts of
        // the task around it, which may have changed by the time it runs
        walkHolds(statement.body, [], {
          ...walk,
          local: localNames(statement),
          volatile: volatileNames(statement.body),
          fresh: freshNames(statement, walk.returning),
        })
        break

      default:
        break
    }

    // a statement that calls an impure task may have written through any record and changed any function's result,
    // so every fact that reads a member or a call goes. Facts about plain locals stay: no callee can reach them,
    // except through a closure, and a name a closure writes is volatile and never had a fact to begin with.
    //
    // ONE EXCEPTION, `p/push v` on a plain path with a pure argument: the list's length grows by exactly one, so
    // the facts about `@length:p` are rewritten (old length is new length less one) rather than forgotten. Every
    // OTHER length still goes, because another name may hold the same list.
    const grown = pushedPath(statement, walk)

    if (grown !== undefined) {
      const key = `@length:${grown}`
      // a push to a name bound only to fresh lists leaves the length of every list that is not that one: another such
      // name (each holds lists only it made), or a parameter the task never rebinds (it held its list before the fresh
      // one existed). A path into a list is not covered: the fresh list may have been pushed into it.
      const apart = (k: string): boolean => {
        const other = k.startsWith('@length:') ? k.slice('@length:'.length) : undefined

        return (
          other !== undefined &&
          !other.includes('/') &&
          other !== grown &&
          walk.fresh?.has(grown) === true &&
          (walk.fresh.has(other) || walk.params?.has(other) === true)
        )
      }

      current = current
        .filter(q => {
          for (const k of q.linear.terms.keys()) {
            if (k !== key && /[^a-z0-9_#-]/.test(k) && !k.startsWith('__') && !apart(k)) {
              return false
            }
          }

          return true
        })
        .map(q => {
          const a = q.linear.terms.get(key) ?? 0

          return a === 0
            ? q
            : {
                ...q,
                linear: { ...q.linear, constant: q.linear.constant - a },
              }
        })
    } else if (
      statement.form !== 'function' &&
      !onlyPushingLoop(statement, walk) &&
      callsImpure(statement, walk.pure, walk.functions, walk.local) &&
      // a `set` inside a list of scalars, or a call to a task that only does such things, changes no length, and no
      // fact here reads anything else it may change (toLinear reads no state but lengths)
      !onlyKeepsLengths(statement, walk)
    ) {
      // an impure call that could not have reached a LOCAL list (it was handed only scalars, and it is a task of the
      // program rather than a function value) leaves local lengths alone. Every other state fact still goes.
      const reached = reachesLists(statement, walk)

      current = current.filter(q => {
        if (!mentionsAtom(q)) {
          return true
        }

        if (reached) {
          return false
        }

        for (const key of q.linear.terms.keys()) {
          if (key.startsWith('@') && !walk.local.has(keyRoot(key))) {
            return false
          }
        }

        return true
      })
    }
  }
}

// the facts after `x = x + d` (or `x += d`, `x -= d`) where d is linear and does not read x: the old x is the new x
// less d, so a fact `a*x + rest` about the old value is `a*x + rest - a*d` about the new one. Undefined when the
// assignment is not such a shift, and the caller forgets x instead.
function shiftFacts(
  current: Inequality[],
  name: string,
  statement: Extract<Statement, { form: 'assign' }>,
  walk: Walk,
): Inequality[] | undefined {
  if (
    walk.volatile.has(name) ||
    readsAny(statement.value, walk.volatile)
  ) {
    return undefined
  }

  const side: Inequality[] = []
  const value = toLinear(statement.value, side)

  if (!value || side.length > 0) {
    return undefined
  }

  let delta: Linear

  if (statement.op === '=') {
    if ((value.terms.get(name) ?? 0) !== 1) {
      return undefined
    }

    const terms = new Map(value.terms)
    terms.delete(name)
    delta = { terms, constant: value.constant }
  } else if (statement.op === '+=' || statement.op === '-=') {
    if (value.terms.has(name)) {
      return undefined
    }

    delta = statement.op === '+=' ? value : scale(value, -1)
  } else {
    return undefined
  }

  return current.map(q => {
    const a = q.linear.terms.get(name) ?? 0

    return a === 0
      ? q
      : { ...q, linear: add(q.linear, scale(delta, -a)) }
  })
}

// `@length:name == n`
function literalLength(name: string, n: number): Inequality[] {
  const atom = linear({ [`@length:${name}`]: 1 })
  const count = linear({}, n)

  return [atMost(atom, count), atLeast(atom, count)]
}

// The lengths of the program's CONSTANT TABLES: a module-level `host` bound to a list literal (an S-box, a round
// constant table) that nothing anywhere could change. Nothing writes it, passes it to a call that is not pure
// (which could push to it), or calls a method on it. A PURE task cannot change its argument (facts.ts: a write
// through a parameter makes a task impure), so handing the table to one is a read. Every task may assume those
// lengths from its first line.
function constantTableLengths(
  program: Program,
  pure: Set<string>,
): Inequality[] {
  const functions = functionNames(program)
  const tables = new Map<string, number>()

  for (const statement of program) {
    if (
      statement.form === 'let' &&
      !statement.mutable &&
      statement.init.form === 'array'
    ) {
      tables.set(statement.name, statement.init.items.length)
    }
  }

  if (tables.size === 0) {
    return []
  }

  const touched = new Set<string>()
  const stack: unknown[] = [program]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'assign') {
      const root = rootName(record.target as Expression)

      if (root !== undefined) {
        touched.add(root)
      }
    }

    // a let of the same name elsewhere is a different binding, and shadows the table where it is in scope
    if (record.form === 'let' && tables.has(record.name as string)) {
      const at = program.indexOf(record as unknown as Statement)

      if (at < 0) {
        touched.add(record.name as string)
      }
    }

    // another dialect's node may also be called `call` and carry no arguments, so the shape is checked, not assumed
    if (record.form === 'call' && Array.isArray(record.args)) {
      const call = record as unknown as Extract<Expression, { form: 'call' }>
      // a pure task of the program reads its arguments and never writes them, and when it answers a SCALAR it cannot
      // hand the table back under another name for someone else to push to. Anything else might.
      const scalar = new Set(['number', 'float', 'boolean', 'string', 'unit', 'bytes'])
      const reads =
        call.callee?.form === 'variable' &&
        functions.has(call.callee.name) &&
        pure.has(call.callee.name) &&
        scalar.has(call.type?.kind ?? '')

      for (const argument of reads ? [] : call.args) {
        const root =
          argument.form === 'variable' || argument.form === 'member'
            ? rootName(argument)
            : undefined

        if (root !== undefined) {
          touched.add(root)
        }
      }

      if (call.callee?.form === 'member') {
        const root = rootName(call.callee)

        if (root !== undefined) {
          touched.add(root)
        }
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return [...tables]
    .filter(([name]) => !touched.has(name))
    .flatMap(([name, n]) => literalLength(name, n))
}

const SCALAR_KINDS = new Set(['number', 'float', 'boolean', 'string', 'unit', 'bytes'])

// does an expression carry no reference to a Term value: its type is a scalar, it reads one element out of a list
// whose elements are scalars (the generic `get` often comes back typed unknown though its list is `list, number`), or
// it reads a local that only ever holds such values (scalarLocals)
function scalarValue(e: Expression, locals?: Set<string>): boolean {
  if (SCALAR_KINDS.has(e.type?.kind ?? '')) {
    return true
  }

  if (e.form === 'variable' && locals?.has(e.name)) {
    return true
  }

  // arithmetic and comparison of scalars is a scalar, whatever type the checker left on the node
  if (e.form === 'binary') {
    return scalarValue(e.left, locals) && scalarValue(e.right, locals)
  }

  if (e.form === 'integer' || e.form === 'boolean' || e.form === 'string') {
    return true
  }

  const fromList = (target: Expression): boolean =>
    target.type?.kind === 'array' &&
    SCALAR_KINDS.has(target.type.element.kind)

  if (e.form === 'member' && e.index) {
    return fromList(e.target)
  }

  return (
    e.form === 'call' &&
    e.callee.form === 'member' &&
    (e.callee.name === 'get' || e.callee.name === 'at') &&
    fromList(e.callee.target)
  )
}

// The locals of a task that only ever hold scalars: every `save` / `host` of the name, and every plain assignment to
// it, is a scalar value given the others (a fixed point from "all of them" down). A read out of a list the checker
// left typed unknown is the common case: `save p0, read rk/{i}` over a list of numbers.
function scalarLocals(body: Statement[], params: { name: string; type?: { kind: string } }[]): Set<string> {
  const values = new Map<string, Expression[]>()
  const disqualified = new Set<string>()
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'let') {
      const list = values.get(record.name as string) ?? []
      list.push(record.init as Expression)
      values.set(record.name as string, list)
    } else if (record.form === 'assign') {
      const target = record.target as Expression

      if (target.form === 'variable') {
        const list = values.get(target.name) ?? []
        list.push(record.value as Expression)
        values.set(target.name, list)
      }
    } else if (record.form === 'for-each') {
      // a loop item holds whatever the sequence holds, which this does not track
      disqualified.add(record.item as string)
    } else if (record.form === 'closure' || record.form === 'function') {
      // a name a closure writes, or a closure's own parameter, is not tracked here
      for (const name of writtenNames(record.body)) {
        disqualified.add(name)
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  // a parameter typed as a scalar is one; a parameter of any other type is not, and is never assigned a scalar view
  for (const param of params) {
    if (!SCALAR_KINDS.has(param.type?.kind ?? '')) {
      disqualified.add(param.name)
    }
  }

  const scalars = new Set(
    [...values.keys()].filter(name => !disqualified.has(name)),
  )
  let changed = true

  while (changed) {
    changed = false

    for (const name of [...scalars]) {
      if (!values.get(name)!.every(v => scalarValue(v, scalars))) {
        scalars.delete(name)
        changed = true
      }
    }
  }

  return scalars
}

// could an impure call in this statement reach a list the task holds? Only through what it is handed, a method
// called on a value, or a function value (which may close over anything). Native code cannot reach a Term local any
// other way. So an impure call to a TASK OF THE PROGRAM, handed only scalars, reaches no local list. A closure the
// statement builds is walked into, since it may be what gets called.
function reachesLists(statement: unknown, walk: Walk): boolean {
  let reached = false
  const stack: unknown[] = [statement]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !reached) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (
      record.form === 'call' &&
      Array.isArray(record.args) &&
      record.callee !== undefined &&
      callsImpure({ ...record, args: [] }, walk.pure, walk.functions, walk.local)
    ) {
      const callee = record.callee as Expression
      const readsAList =
        callee.form === 'member' &&
        !callee.index &&
        READ_ONLY_LIST_METHODS.has(callee.name) &&
        callee.target.type?.kind === 'array' &&
        (record.args as Expression[]).every(a =>
          SCALAR_KINDS.has(a.type?.kind ?? ''),
        )

      const scalars = (record.args as Expression[]).every(a =>
        scalarValue(a, walk.scalars),
      )
      const root = callee.form === 'member' ? rootName(callee) : undefined
      // a function of a native module: a name that is neither a local, a module-level binding nor a task
      const onModule =
        root !== undefined &&
        !walk.local.has(root) &&
        !walk.globals.has(root) &&
        !walk.functions.has(root)

      if (readsAList || keepsLengths(record, walk)) {
        // reading a list changes nothing, and neither a `set` inside one nor a length-keeping task changes a length
      } else if (callee.form === 'variable' && walk.functions.has(callee.name)) {
        // a task of the program reaches no list it is not handed only when it touches no Term state at all
        // (facts.ts stateFreeFunctions); handed a list, it may change that list
        if (!(walk.stateFree.has(callee.name) && scalars)) {
          reached = true
        }
      } else if (onModule && scalars) {
        // native code handed only scalars holds no Term value: the assumption the trust ledger names
      } else {
        reached = true
      }
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return reached
}

// a call that changes no list's length: `xs/get i` or `xs/at i` on a list, `xs/set i, v` on a list of scalars (it owes
// `0 <= i < xs/length` as a tier-0 obligation, so it lands inside), or a task that only ever does such things
// (facts.ts lengthKeepingFunctions). What it is handed may still change other ways, which the caller checks.
function keepsLengths(call: Record<string, unknown>, walk: Walk): boolean {
  const callee = call.callee as Expression | undefined
  const args = (call.args as Expression[] | undefined) ?? []

  if (callee?.form === 'variable') {
    return walk.functions.has(callee.name) && walk.keeping.has(callee.name)
  }

  if (callee?.form !== 'member' || callee.index || callee.target.type?.kind !== 'array') {
    return false
  }

  const element = callee.target.type.element.kind

  return (
    ((callee.name === 'get' || callee.name === 'at') && args.length === 1) ||
    (callee.name === 'set' && args.length === 2 && SCALAR_KINDS.has(element))
  )
}

// does every impure call in a statement change no length (keepsLengths), with none passing a function value on
function onlyKeepsLengths(statement: unknown, walk: Walk): boolean {
  let other = false
  const stack: unknown[] = [statement]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure' || record.form === 'function') {
      // a function made here may be called anywhere
      other = true
      continue
    }

    if (
      record.form === 'variable' &&
      walk.functions.has(record.name as string) &&
      !walk.pure.has(record.name as string)
    ) {
      // an impure task passed as a value: callsImpure reads it as a call
      other = true
      continue
    }

    if (record.form === 'call' && record.callee !== undefined) {
      const head = { ...record, args: [] }
      const callee = record.callee as Expression

      if (
        callsImpure(head, walk.pure, walk.functions, walk.local) &&
        !keepsLengths(record, walk) &&
        !(callee.form === 'member' &&
          !callee.index &&
          READ_ONLY_LIST_METHODS.has(callee.name) &&
          callee.target.type?.kind === 'array')
      ) {
        other = true
      }

      // the callee itself was judged; only the arguments are left to look at
      stack.push(record.args)

      if (callee.form === 'member') {
        stack.push(callee.target)
      }

      continue
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return !other
}

// how a loop body changes state: the number of `p/push v` statements (pure arguments) when those are its ONLY
// impure calls, or false when it makes any other impure call. A closure's body counts, because it may run here.
function bodyOnlyPushes(body: Statement[], walk: Walk): number | false {
  let pushes = 0
  let other = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !other) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'expression' && pushedPath(record as unknown as Statement, walk) !== undefined) {
      pushes++
      // the pushed value was checked pure by pushedPath; nothing under it needs walking
      continue
    }

    // an impure call that cannot reach a local list (reachesLists) is not a change to any length this walk tracks;
    // keepMonotone drops what it may have changed (the lengths of lists that are not local) separately
    if (
      record.form === 'call' &&
      Array.isArray(record.args) &&
      record.callee !== undefined &&
      reachesLists(record, walk)
    ) {
      other = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return other ? false : pushes
}

// a walk whose only change to state is pushes with pure arguments, from a condition or sequence that calls nothing
// impure: keepAcrossTurns has already kept exactly the length facts such a walk preserves, so the blanket rule for
// impure statements must not forget them after it
function onlyPushingLoop(statement: Statement, walk: Walk): boolean {
  if (statement.form === 'while') {
    return (
      !callsImpure(statement.cond, walk.pure, walk.functions, walk.local) &&
      bodyOnlyPushes(statement.body, walk) !== false &&
      !writesThroughMember(statement.body)
    )
  }

  if (statement.form === 'for-each') {
    return (
      !callsImpure(statement.iterable, walk.pure, walk.functions, walk.local) &&
      bodyOnlyPushes(statement.body, walk) !== false &&
      !writesThroughMember(statement.body)
    )
  }

  return false
}

// does a body write through a member anywhere (a closure's body included)
function writesThroughMember(body: Statement[]): boolean {
  let found = false
  const stack: unknown[] = [body]
  const seen = new Set<unknown>()

  while (stack.length > 0 && !found) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (
      record.form === 'assign' &&
      (record.target as { form?: string } | undefined)?.form === 'member'
    ) {
      found = true
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span' && key !== 'binding') {
        stack.push(record[key])
      }
    }
  }

  return found
}

// the path a statement pushes one item onto, when it is exactly `call p/push, <value>` with `p` a plain path and the
// value calling nothing impure; undefined for anything else
function pushedPath(statement: Statement, walk: Walk): string | undefined {
  if (statement.form !== 'expression' || statement.expr.form !== 'call') {
    return undefined
  }

  const call = statement.expr

  // only the native list's `push` adds exactly one item: a form may define its own `push` (the stdlib's heap does)
  // over a `length` field, so the receiver must be typed as a list. What is pushed may be computed by anything that
  // cannot reach a list (a native bit operation, say), since only lengths are tracked.
  if (
    call.callee?.form !== 'member' ||
    call.callee.name !== 'push' ||
    call.callee.index ||
    call.callee.target.type?.kind !== 'array' ||
    !Array.isArray(call.args) ||
    call.args.length !== 1 ||
    reachesLists(call.args, walk)
  ) {
    return undefined
  }

  return plainPath(call.callee.target)
}

// a fact over an atom that stands for state (`__mod` atoms are only bounds and stay)
function mentionsAtom(q: Inequality): boolean {
  for (const key of q.linear.terms.keys()) {
    if (/[^a-z0-9_#-]/.test(key) && !key.startsWith('__mod')) {
      return true
    }
  }

  return false
}

// the holds inside the closures an expression builds. A closure may run at any later time, so its holds are checked
// with nothing assumed about the world around it, and with its own parameters and writes as its locals.
function holdsInExpression(expression: Expression, walk: Walk): void {
  const closures: Extract<Expression, { form: 'closure' }>[] = []
  const stack: unknown[] = [expression]
  const seen = new Set<unknown>()

  while (stack.length > 0) {
    const node = stack.pop()

    if (node === null || typeof node !== 'object' || seen.has(node)) {
      continue
    }

    seen.add(node)

    if (Array.isArray(node)) {
      stack.push(...node)
      continue
    }

    const record = node as Record<string, unknown>

    if (record.form === 'closure') {
      // nested closures inside this one are reached by walking its body, not here
      closures.push(record as Extract<Expression, { form: 'closure' }>)
      continue
    }

    for (const key of Object.keys(record)) {
      if (key !== 'type' && key !== 'span') {
        stack.push(record[key])
      }
    }
  }

  for (const closure of closures) {
    const local = writtenNames(closure.body)

    for (const param of closure.params) {
      local.add(param.name)
    }

    for (const name of walk.local) {
      local.add(name)
    }

    walkHolds(closure.body, [], {
      ...walk,
      local,
      volatile: volatileNames(closure.body),
    })
  }
}
