// Multivariate real-arithmetic decision by cylindrical algebraic decomposition (CAD) -- the lift of the univariate
// Sturm base case (`sturm.ts`) to two variables. It decides BIVARIATE non-negativity: `p(x, y) >= 0 for all real x, y`.
//
// The construction is the CAD pipeline for one polynomial in the variables x < y:
//   1. PROJECT onto the base line (the x-axis). The truth of "p(x0, .) >= 0 for all y" changes only where the real
//      y-root structure of the fibre polynomial p(x0, y) changes: where a leading coefficient vanishes (a degree drop)
//      or where two real roots collide (the y-discriminant vanishes). So the projection set is the y-coefficient
//      polynomials a_j(x) together with the y-DISCRIMINANT disc_y(p)(x) = res_y(p, dp/dy). Their real roots are the
//      critical x-values.
//   2. DECOMPOSE the base line into the sign-invariant cells of the projection polynomial, via the one-dimensional CAD
//      (`sturm.cellSamples`): one rational sample x* strictly inside each cell.
//   3. LIFT: on each base cell the fibre's y-root structure is constant, so the truth of "p(x, .) >= 0 for all y" is
//      constant across the cell and is decided at the single rational sample x* by the univariate decision on p(x*, y).
//
// `p >= 0` everywhere holds iff every base-cell fibre is non-negative. This is sound and COMPLETE: the cells partition
// the line by exactly the structure changes, and the rational samples are dense in the cells, so by continuity the
// algebraic cell boundaries are covered too. It proves non-negativity with NO sum-of-squares certificate -- including
// the MOTZKIN polynomial `x^4 y^2 + x^2 y^4 - 3 x^2 y^2 + 1`, the classic non-negative form that is provably not a sum
// of squares. All arithmetic is exact (BigInt rationals). Browser-safe.

import {
  cellSamplesBig,
  rationalNonNegativeEverywhere,
} from '@term/make/code/check/sturm'

// a bivariate polynomial: `coeff[i][j]` = integer coefficient of `x^i y^j`. Ragged rows are padded as zero.
export type Bivariate = bigint[][]

const bigAbs = (a: bigint): bigint => (a < 0n ? -a : a)

// ----- integer polynomials in x (the coefficient ring of the y-polynomial) -----

type IntPoly = bigint[] // index = power of x

function trimInt(p: IntPoly): IntPoly {
  let n = p.length

  while (n > 0 && p[n - 1] === 0n) {
    n--
  }

  return p.slice(0, n)
}

function addInt(a: IntPoly, b: IntPoly): IntPoly {
  const n = Math.max(a.length, b.length)
  const out: IntPoly = []

  for (let i = 0; i < n; i++) {
    out.push((a[i] ?? 0n) + (b[i] ?? 0n))
  }

  return trimInt(out)
}

function mulInt(a: IntPoly, b: IntPoly): IntPoly {
  if (a.length === 0 || b.length === 0) {
    return []
  }

  const out: IntPoly = new Array(a.length + b.length - 1).fill(0n)

  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j]! += a[i]! * b[j]!
    }
  }

  return trimInt(out)
}

// ----- the bivariate as a y-polynomial whose coefficients are x-polynomials -----

// the y-degree of `p` (the largest j with a non-zero x^i y^j term)
function yDegree(p: Bivariate): number {
  let degree = 0

  for (const row of p) {
    for (let j = 0; j < row.length; j++) {
      if (row[j] !== 0n) {
        degree = Math.max(degree, j)
      }
    }
  }

  return degree
}

// the x-polynomial coefficient of y^j (i.e. a_j(x) where p = sum_j a_j(x) y^j)
function yCoefficient(p: Bivariate, j: number): IntPoly {
  const out: IntPoly = []

  for (let i = 0; i < p.length; i++) {
    out[i] = p[i]![j] ?? 0n
  }

  return trimInt(out)
}

// the fibre polynomial p(k, y): substitute the integer x = k, giving a univariate polynomial in y (index = power of y)
function fibreAtInteger(p: Bivariate, k: bigint): IntPoly {
  const dy = yDegree(p)
  const out: IntPoly = new Array(dy + 1).fill(0n)

  for (let j = 0; j <= dy; j++) {
    let acc = 0n

    // Horner in x over the coefficient column for y^j
    for (let i = p.length - 1; i >= 0; i--) {
      acc = acc * k + (p[i]![j] ?? 0n)
    }

    out[j] = acc
  }

  return trimInt(out)
}

// the fibre polynomial p(n/d, y) at a RATIONAL x = n/d, returned as exact rational coefficients `[num, den]` per power
// of y. Multiplying through by d^(x-degree) clears denominators while preserving every y-sign, but keeping it rational
// is simplest and the univariate decision consumes rationals directly.
function fibreAtRational(p: Bivariate, n: bigint, d: bigint): [bigint, bigint][] {
  const dy = yDegree(p)
  const dx = p.length - 1
  const out: [bigint, bigint][] = []

  for (let j = 0; j <= dy; j++) {
    // a_j(n/d) = (sum_i c[i][j] n^i d^(dx-i)) / d^dx
    let num = 0n

    for (let i = 0; i <= dx; i++) {
      const c = p[i]?.[j] ?? 0n

      if (c !== 0n) {
        num += c * n ** BigInt(i) * d ** BigInt(dx - i)
      }
    }

    out[j] = [num, d ** BigInt(dx)]
  }

  return out
}

// ----- exact integer resultant (Sylvester matrix, fraction-free Bareiss determinant) -----

// the determinant of an integer matrix by the Bareiss algorithm: fraction-free Gaussian elimination, every intermediate
// is an exact integer (a minor of the original), so no rounding. Returns 0 for a singular matrix.
function bareissDeterminant(matrix: bigint[][]): bigint {
  const n = matrix.length

  if (n === 0) {
    return 1n
  }

  const m = matrix.map(row => row.slice())
  let prev = 1n
  let sign = 1n

  for (let k = 0; k < n - 1; k++) {
    if (m[k]![k] === 0n) {
      // find a row below with a non-zero pivot and swap (flips the sign)
      let swap = -1

      for (let i = k + 1; i < n; i++) {
        if (m[i]![k] !== 0n) {
          swap = i
          break
        }
      }

      if (swap === -1) {
        return 0n
      }

      ;[m[k], m[swap]] = [m[swap]!, m[k]!]
      sign = -sign
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        m[i]![j] = (m[i]![j]! * m[k]![k]! - m[i]![k]! * m[k]![j]!) / prev
      }

      m[i]![k] = 0n
    }

    prev = m[k]![k]!
  }

  return sign * m[n - 1]![n - 1]!
}

// the resultant of two univariate integer polynomials (index = power), via the Sylvester matrix determinant. Zero iff
// the two share a common root. `resultant(f, f')` vanishes exactly when `f` has a repeated root, so it is the
// discriminant up to a leading-coefficient factor -- which is all the projection needs (its real roots).
function resultant(a: IntPoly, b: IntPoly): bigint {
  const f = trimInt(a)
  const g = trimInt(b)

  if (f.length === 0 || g.length === 0) {
    return 0n
  }

  const m = f.length - 1 // degree of f
  const n = g.length - 1 // degree of g

  if (m === 0 && n === 0) {
    return 1n // two non-zero constants share no root
  }

  const size = m + n
  const matrix: bigint[][] = []

  // n rows of f's coefficients (highest power first), each shifted right by one
  for (let r = 0; r < n; r++) {
    const row: bigint[] = new Array(size).fill(0n)

    for (let i = 0; i <= m; i++) {
      row[r + i] = f[m - i]!
    }

    matrix.push(row)
  }

  // m rows of g's coefficients (highest power first), each shifted right by one
  for (let r = 0; r < m; r++) {
    const row: bigint[] = new Array(size).fill(0n)

    for (let i = 0; i <= n; i++) {
      row[r + i] = g[n - i]!
    }

    matrix.push(row)
  }

  return bareissDeterminant(matrix)
}

// the derivative with respect to y of a fibre polynomial (index = power of y)
function derivativeY(fibre: IntPoly): IntPoly {
  const out: IntPoly = []

  for (let j = 1; j < fibre.length; j++) {
    out.push(BigInt(j) * fibre[j]!)
  }

  return trimInt(out)
}

// ----- the y-discriminant as an x-polynomial, by evaluation and interpolation -----

// Lagrange interpolation of the integer polynomial through the points `(x_i, y_i)`: the unique polynomial of degree
// < count that hits every sample. Returned with integer coefficients scaled to clear denominators (its real roots, all
// the projection needs, are unchanged by a non-zero scale).
function interpolate(points: [bigint, bigint][]): IntPoly {
  // accumulate the polynomial as exact rationals: result = sum_i y_i * prod_{j != i} (x - x_j) / (x_i - x_j)
  type Rat = { n: bigint; d: bigint }

  const bgcd = (a: bigint, b: bigint): bigint => {
    a = bigAbs(a)
    b = bigAbs(b)

    while (b) {
      ;[a, b] = [b, a % b]
    }

    return a
  }

  const mk = (n: bigint, d: bigint): Rat => {
    if (d < 0n) {
      n = -n
      d = -d
    }

    const g = bgcd(n, d) || 1n

    return { n: n / g, d: d / g }
  }

  const radd = (a: Rat, b: Rat): Rat => mk(a.n * b.d + b.n * a.d, a.d * b.d)
  const rmul = (a: Rat, b: Rat): Rat => mk(a.n * b.n, a.d * b.d)

  let acc: Rat[] = [] // rational polynomial, index = power

  const addScaled = (poly: Rat[], scale: Rat): void => {
    for (let i = 0; i < poly.length; i++) {
      acc[i] = radd(acc[i] ?? mk(0n, 1n), rmul(poly[i]!, scale))
    }
  }

  for (let i = 0; i < points.length; i++) {
    const [xi, yi] = points[i]!
    let basis: Rat[] = [mk(1n, 1n)] // the polynomial 1
    let denom = 1n

    for (let j = 0; j < points.length; j++) {
      if (j === i) {
        continue
      }

      const xj = points[j]![0]
      // multiply basis by (x - xj)
      const next: Rat[] = new Array(basis.length + 1).fill(null).map(() => mk(0n, 1n))

      for (let k = 0; k < basis.length; k++) {
        next[k] = radd(next[k]!, rmul(basis[k]!, mk(-xj, 1n)))
        next[k + 1] = radd(next[k + 1]!, basis[k]!)
      }

      basis = next
      denom *= xi - xj
    }

    addScaled(basis, mk(yi, denom))
  }

  // clear denominators: multiply by the lcm of all denominators
  let lcm = 1n

  for (const c of acc) {
    if (c && c.n !== 0n) {
      lcm = (lcm / bgcd(lcm, c.d)) * c.d
    }
  }

  return trimInt(acc.map(c => (c ? (c.n * lcm) / c.d : 0n)))
}

// the y-discriminant of `p` as an x-polynomial: res_y(p, dp/dy) sampled at enough integer x where the y-degree is full,
// then interpolated. Its real roots are the x where the fibre's real y-roots collide.
function discriminantX(p: Bivariate): IntPoly {
  const dy = yDegree(p)

  if (dy < 2) {
    return [] // a fibre of y-degree < 2 has no discriminant structure (no two roots to collide)
  }

  const dx = p.length - 1
  const leadY = yCoefficient(p, dy) // a_dy(x); the y-degree is full exactly where this is non-zero
  const bound = (2 * dy - 1) * dx + 2 // an upper bound on the x-degree of the resultant
  const points: [bigint, bigint][] = []

  for (let k = 0n; points.length <= bound; k++) {
    // skip the finitely many x where the y-degree drops (leadY(k) == 0); there the resultant value would not lie on the
    // generic resultant polynomial, and those x are already caught by the leadY factor of the projection.
    let lead = 0n

    for (let i = leadY.length - 1; i >= 0; i--) {
      lead = lead * k + leadY[i]!
    }

    if (lead === 0n) {
      continue
    }

    const fibre = fibreAtInteger(p, k)
    points.push([k, resultant(fibre, derivativeY(fibre))])

    if (k > BigInt(bound) + 8n) {
      break // safety: enough generic points were sampled
    }
  }

  return interpolate(points)
}

// the PROJECTION polynomial on the x-axis: the product of the y-discriminant and every (non-zero) y-coefficient
// polynomial a_j(x). Its real roots are a superset of the critical x-values (where the fibre's >= 0 truth can change),
// so cell-decomposing by it never merges two differently-behaved x-regions -- which keeps the lift sound.
function projectionX(p: Bivariate): IntPoly {
  let proj: IntPoly = [1n]
  const dy = yDegree(p)

  for (let j = 0; j <= dy; j++) {
    const aj = yCoefficient(p, j)

    if (aj.length > 0) {
      proj = mulInt(proj, aj)
    }
  }

  const disc = discriminantX(p)

  if (disc.length > 0) {
    proj = mulInt(proj, disc)
  }

  return proj
}

// is `p(x, y) >= 0` for ALL real x and y? The bivariate CAD decision.
export function bivariateNonNegative(p: Bivariate): boolean {
  const dy = yDegree(p)

  // no real y: p is a univariate x-polynomial -- decide it directly by the one-dimensional CAD.
  if (dy === 0) {
    const xPoly = yCoefficient(p, 0)

    return rationalNonNegativeEverywhere(xPoly.map(c => [c, 1n]))
  }

  // an ODD y-degree fibre runs to -infinity in y, so it is negative somewhere -- unless the leading y-coefficient can
  // vanish, which the cell sampling below detects. The general path handles this uniformly, so no special case is
  // needed here; we proceed to project and lift.

  const proj = projectionX(p)
  // the base cells: one rational sample x* strictly inside each sign-invariant interval of the projection. A constant
  // projection (no critical x) yields a single cell sampled at 0.
  const samples =
    proj.length <= 1
      ? ([[0n, 1n]] as [bigint, bigint][])
      : cellSamplesBig(proj)

  for (const [n, d] of samples) {
    const fibre = fibreAtRational(p, n, d)

    if (!rationalNonNegativeEverywhere(fibre)) {
      return false // this base cell has a fibre that dips below zero
    }
  }

  return true
}
