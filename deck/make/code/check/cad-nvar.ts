// n-variable real-arithmetic decision by cylindrical algebraic decomposition (CAD). It decides `p(x_0, ..., x_{k-1}) >= 0
// for all real arguments` in ANY number of variables, lifting the univariate Sturm base case (`sturm.ts`) through a
// recursive CAD.
//
// The construction, for variables x_0 < x_1 < ... < x_{k-1}:
//   PROJECT  -- eliminate the top variable x_{k-1} from the polynomial set, producing a (k-1)-variable set: each
//               polynomial's DISCRIMINANT and all its COEFFICIENTS in x_{k-1}, plus the PAIRWISE RESULTANTS among the
//               set. Over any cell of the base space, this Collins projection makes the real roots of the set in the top
//               variable vary without collision (delineability), so the cell structure is constant across the cell.
//   DECOMPOSE -- recursively CAD the (k-1)-variable base, getting one RATIONAL sample point in each full-dimensional
//               (open) base cell.
//   LIFT      -- over each base sample s, substitute it into the polynomial(s) to get univariate fibres in x_{k-1},
//               and pick one RATIONAL sample strictly inside each open root interval. The pairs (s, sample) are rational
//               points, one in each full-dimensional cell of the whole space.
//
// `p >= 0` everywhere holds iff `p >= 0` at every such sample. This is SOUND and COMPLETE for the (closed) non-negativity
// condition: the samples meet every full-dimensional cell, p has a constant sign on each, and the open cells are dense,
// so non-negativity on them extends to the closure (all of R^k) by continuity. Every sample point is RATIONAL -- the
// base samples are rational by induction and each fibre adds a rational coordinate -- so all arithmetic is exact BigInt
// rationals, never an algebraic number. It proves non-negativity with NO sum-of-squares certificate, including the
// trivariate CHOI-LAM form `x^4 y^2 + y^4 z^2 + z^4 x^2 - 3 x^2 y^2 z^2`, a non-negative polynomial that is not a sum of
// squares. Browser-safe.

import { cellSamplesBig } from '@term/make/code/check/sturm'

// a multivariate polynomial: the exponent tuple (length = the variable count) joined by commas, mapped to its integer
// coefficient. The empty map is the zero polynomial.
export type NPoly = Map<string, bigint>

const bigAbs = (a: bigint): bigint => (a < 0n ? -a : a)

function key(exps: number[]): string {
  return exps.join(',')
}

function exps(k: string): number[] {
  return k === '' ? [] : k.split(',').map(Number)
}

function addTerm(p: NPoly, k: string, c: bigint): void {
  if (c === 0n) {
    return
  }

  const next = (p.get(k) ?? 0n) + c

  if (next === 0n) {
    p.delete(k)
  } else {
    p.set(k, next)
  }
}

// the degree of `p` in variable `v`
function degreeIn(p: NPoly, v: number): number {
  let d = 0

  for (const k of p.keys()) {
    d = Math.max(d, exps(k)[v]!)
  }

  return d
}

// the derivative of `p` with respect to variable `v`
function derivativeIn(p: NPoly, v: number): NPoly {
  const out: NPoly = new Map()

  for (const [k, c] of p) {
    const e = exps(k)
    const power = e[v]!

    if (power > 0) {
      const f = [...e]
      f[v] = power - 1
      addTerm(out, key(f), c * BigInt(power))
    }
  }

  return out
}

// the coefficient of `x_v^d` in `p`, with the v-th exponent zeroed (a polynomial in the same variables, not mentioning v)
function coefficientIn(p: NPoly, v: number, d: number): NPoly {
  const out: NPoly = new Map()

  for (const [k, c] of p) {
    const e = exps(k)

    if (e[v] === d) {
      const f = [...e]
      f[v] = 0
      addTerm(out, key(f), c)
    }
  }

  return out
}

// substitute the integer assignment `vals` for every variable EXCEPT `v`, giving a univariate integer polynomial in `v`
// (index = power of v)
function evalExcept(p: NPoly, v: number, vals: bigint[]): bigint[] {
  let deg = 0
  const byPower = new Map<number, bigint>()

  for (const [k, c] of p) {
    const e = exps(k)
    let term = c

    for (let i = 0; i < e.length; i++) {
      if (i !== v && e[i]! > 0) {
        term *= vals[i]! ** BigInt(e[i]!)
      }
    }

    const power = e[v]!
    byPower.set(power, (byPower.get(power) ?? 0n) + term)
    deg = Math.max(deg, power)
  }

  const out: bigint[] = new Array(deg + 1).fill(0n)

  for (const [power, c] of byPower) {
    out[power] = c
  }

  return trimUni(out)
}

// ----- univariate integer polynomial helpers (for the resultant) -----

function trimUni(p: bigint[]): bigint[] {
  let n = p.length

  while (n > 0 && p[n - 1] === 0n) {
    n--
  }

  return p.slice(0, n)
}

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

// the resultant of two univariate integer polynomials (index = power), by the Sylvester matrix determinant
function uniResultant(a: bigint[], b: bigint[]): bigint {
  const f = trimUni(a)
  const g = trimUni(b)

  if (f.length === 0 || g.length === 0) {
    return 0n
  }

  const m = f.length - 1
  const n = g.length - 1

  if (m === 0 && n === 0) {
    return 1n
  }

  const size = m + n
  const matrix: bigint[][] = []

  for (let r = 0; r < n; r++) {
    const row: bigint[] = new Array(size).fill(0n)

    for (let i = 0; i <= m; i++) {
      row[r + i] = f[m - i]!
    }

    matrix.push(row)
  }

  for (let r = 0; r < m; r++) {
    const row: bigint[] = new Array(size).fill(0n)

    for (let i = 0; i <= n; i++) {
      row[r + i] = g[n - i]!
    }

    matrix.push(row)
  }

  return bareissDeterminant(matrix)
}

// ----- exact rationals (for the interpolation) -----

type Rat = { n: bigint; d: bigint }

function bgcd(a: bigint, b: bigint): bigint {
  a = bigAbs(a)
  b = bigAbs(b)

  while (b) {
    ;[a, b] = [b, a % b]
  }

  return a
}

function rat(n: bigint, d: bigint = 1n): Rat {
  if (d < 0n) {
    n = -n
    d = -d
  }

  const g = bgcd(n, d) || 1n

  return { n: n / g, d: d / g }
}

function radd(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d)
}

function rmul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d)
}

// ----- the resultant in variable `last` as a polynomial in the lower variables, by evaluation and interpolation -----

// eliminate the top variable `last` (= nvars - 1) from `p` and `q`: their resultant is a polynomial in the lower
// variables 0..last-1. We sample it on an integer grid (at each grid point both polynomials become univariate in `last`
// and the resultant is a number) and interpolate. Returned over `last` lower variables (tuples of length `last`).
function resultantInLast(p: NPoly, q: NPoly, nvars: number): NPoly {
  const last = nvars - 1
  const lower = last // number of lower variables 0..last-1

  // a per-variable degree bound on the resultant: deg_w(res) <= deg_w(p) deg_last(q) + deg_w(q) deg_last(p)
  const dpLast = degreeIn(p, last)
  const dqLast = degreeIn(q, last)
  const bounds: number[] = []

  for (let w = 0; w < lower; w++) {
    bounds.push(degreeIn(p, w) * dqLast + degreeIn(q, w) * dpLast)
  }

  const valueAt = (point: number[]): bigint => {
    const vals: bigint[] = new Array(nvars).fill(0n)

    for (let w = 0; w < lower; w++) {
      vals[w] = BigInt(point[w]!)
    }

    return uniResultant(evalExcept(p, last, vals), evalExcept(q, last, vals))
  }

  return interpolateLower(lower, bounds, valueAt)
}

// interpolate a polynomial in the lower variables 0..lower-1 from its values on the integer grid `[0..bounds[w]]`.
// Recursive (a tensor of univariate Lagrange interpolations); coefficients are exact rationals during the build and
// cleared to integers at the end.
function interpolateLower(
  lower: number,
  bounds: number[],
  valueAt: (point: number[]) => bigint,
): NPoly {
  // build a rational polynomial keyed by lower-variable exponent tuples (length `lower`)
  const rec = (
    dim: number,
    prefix: number[],
  ): Map<string, Rat> => {
    if (dim === lower) {
      const v = valueAt(prefix)

      return new Map([['', rat(v)]])
    }

    const degree = bounds[dim]!
    const subs: Map<string, Rat>[] = []

    for (let pt = 0; pt <= degree; pt++) {
      subs.push(rec(dim + 1, [...prefix, pt]))
    }

    // Lagrange-combine the `degree + 1` sub-results over variable `dim`
    const out = new Map<string, Rat>()

    for (let pt = 0; pt <= degree; pt++) {
      // the Lagrange basis polynomial L_pt(x_dim) = prod_{s != pt} (x - s)/(pt - s), as rational coefficients in x_dim
      let basis: Rat[] = [rat(1n)]
      let denom = 1n

      for (let s = 0; s <= degree; s++) {
        if (s === pt) {
          continue
        }

        const next: Rat[] = new Array(basis.length + 1).fill(null).map(() => rat(0n))

        for (let i = 0; i < basis.length; i++) {
          next[i] = radd(next[i]!, rmul(basis[i]!, rat(BigInt(-s))))
          next[i + 1] = radd(next[i + 1]!, basis[i]!)
        }

        basis = next
        denom *= BigInt(pt - s)
      }

      const scale = rat(1n, denom)

      // result += sub_pt(other vars) * L_pt(x_dim); the sub is over dims dim+1.., which are the LATER positions in the
      // tuple. We place x_dim's exponent at position `dim`.
      for (const [subKey, subCoeff] of subs[pt]!) {
        const subExps = subKey === '' ? [] : subKey.split(',').map(Number)

        for (let e = 0; e < basis.length; e++) {
          const l = rmul(basis[e]!, scale)

          if (l.n === 0n) {
            continue
          }

          // assemble the full lower-tuple: positions dim+1.. come from subExps, position dim is `e`, positions < dim are 0
          const full: number[] = new Array(lower).fill(0)
          full[dim] = e

          for (let j = dim + 1; j < lower; j++) {
            full[j] = subExps[j - (dim + 1)] ?? 0
          }

          const fk = key(full)
          out.set(fk, radd(out.get(fk) ?? rat(0n), rmul(subCoeff, l)))
        }
      }
    }

    return out
  }

  const rational = rec(0, [])

  // clear denominators to integers (the resultant is integer-valued, so this is exact; a non-zero scale is irrelevant to
  // the real roots that the CAD uses)
  let lcm = 1n

  for (const r of rational.values()) {
    if (r.n !== 0n) {
      lcm = (lcm / bgcd(lcm, r.d)) * r.d
    }
  }

  const out: NPoly = new Map()

  for (const [k, r] of rational) {
    addTerm(out, k, (r.n * lcm) / r.d)
  }

  return out
}

// ----- the Collins projection -----

const isZero = (p: NPoly): boolean => p.size === 0
const isConstant = (p: NPoly): boolean =>
  p.size === 0 || (p.size === 1 && p.has(key(new Array(numVars(p)).fill(0))))

function numVars(p: NPoly): number {
  for (const k of p.keys()) {
    return exps(k).length
  }

  return 0
}

// project the set of `nvars`-variable polynomials onto the lower `nvars - 1` variables: discriminants and all
// coefficients in the top variable, plus pairwise resultants. Each output polynomial is over the lower variables.
function project(set: NPoly[], nvars: number): NPoly[] {
  const last = nvars - 1
  const out: NPoly[] = []

  const push = (q: NPoly): void => {
    if (!isZero(q) && !isConstantLower(q, nvars - 1)) {
      out.push(q)
    }
  }

  for (const q of set) {
    const dq = degreeIn(q, last)

    // the discriminant (resultant of q and its derivative) when q genuinely involves the top variable
    if (dq >= 1) {
      const der = derivativeIn(q, last)

      if (!isZero(der)) {
        push(resultantInLast(q, der, nvars))
      }
    }

    // every coefficient of the top variable (a polynomial in the lower variables). This includes the leading
    // coefficient (degree drops) and, by taking ALL of them, the points where q vanishes identically in the fibre.
    for (let d = 0; d <= dq; d++) {
      push(dropLast(coefficientIn(q, last, d), nvars))
    }
  }

  // pairwise resultants among DIFFERENT members of the set (needed for delineability when the set has several curves)
  for (let i = 0; i < set.length; i++) {
    for (let j = i + 1; j < set.length; j++) {
      if (degreeIn(set[i]!, last) >= 1 || degreeIn(set[j]!, last) >= 1) {
        push(resultantInLast(set[i]!, set[j]!, nvars))
      }
    }
  }

  return out
}

// drop the (already-zero) top coordinate from a polynomial that does not mention the top variable
function dropLast(p: NPoly, nvars: number): NPoly {
  const out: NPoly = new Map()

  for (const [k, c] of p) {
    const e = exps(k)
    addTerm(out, key(e.slice(0, nvars - 1)), c)
  }

  return out
}

function isConstantLower(p: NPoly, lower: number): boolean {
  if (isZero(p)) {
    return true
  }

  return p.size === 1 && p.has(key(new Array(lower).fill(0)))
}

// ----- the CAD sample points -----

// the product of a set of univariate integer polynomials (their combined roots are the union)
function uniProduct(polys: bigint[][]): bigint[] {
  let out: bigint[] = [1n]

  for (const p of polys) {
    if (trimUni(p).length === 0) {
      continue
    }

    const next: bigint[] = new Array(out.length + p.length - 1).fill(0n)

    for (let i = 0; i < out.length; i++) {
      for (let j = 0; j < p.length; j++) {
        next[i + j]! += out[i]! * p[j]!
      }
    }

    out = trimUni(next)
  }

  return out
}

// substitute the rational point `pt` (one [num, den] per variable) into every polynomial of `set`, fixing all variables
// except the top one, yielding univariate integer fibre polynomials in the top variable. Denominators are cleared by
// scaling, which preserves the real roots.
function fibrePolys(set: NPoly[], nvars: number, pt: [bigint, bigint][]): bigint[][] {
  const last = nvars - 1
  const out: bigint[][] = []

  for (const p of set) {
    const dLast = degreeIn(p, last)
    const coeffs: bigint[] = new Array(dLast + 1).fill(0n)

    // common denominator: the highest total power of any lower variable
    let maxLowerDeg = 0

    for (const k of p.keys()) {
      const e = exps(k)
      let s = 0

      for (let w = 0; w < last; w++) {
        s += e[w]!
      }

      maxLowerDeg = Math.max(maxLowerDeg, s)
    }

    for (const [k, c] of p) {
      const e = exps(k)
      let num = c
      let den = 1n
      let usedLowerDeg = 0

      for (let w = 0; w < last; w++) {
        if (e[w]! > 0) {
          num *= pt[w]![0] ** BigInt(e[w]!)
          den *= pt[w]![1] ** BigInt(e[w]!)
          usedLowerDeg += e[w]!
        }
      }

      // scale every term to the common denominator product (so the cleared coefficients are integers, same real roots)
      let scaleNum = num

      for (const [w] of pt.entries()) {
        if (w >= last) {
          break
        }
      }

      // multiply by den-complement so all terms share denominator prod_w pt[w][1]^maxLowerDeg
      let commonDen = 1n

      for (let w = 0; w < last; w++) {
        commonDen *= pt[w]![1] ** BigInt(maxLowerDeg)
      }

      scaleNum = (num * (commonDen / den))
      coeffs[e[last]!] = (coeffs[e[last]!] ?? 0n) + scaleNum
    }

    out.push(trimUni(coeffs))
  }

  return out
}

// the rational sample points (one per full-dimensional open cell) of the CAD of R^nvars induced by `set`. Each sample is
// an array of `nvars` rationals [num, den].
function cadSamples(set: NPoly[], nvars: number): [bigint, bigint][][] {
  if (nvars === 1) {
    const product = uniProduct(set.map(p => fibreUnivariate(p)))
    const samples = product.length <= 1 ? [[0n, 1n] as [bigint, bigint]] : cellSamplesBig(product)

    return samples.map(s => [s])
  }

  const proj = project(set, nvars)
  const lower = cadSamples(proj.length === 0 ? [] : proj, nvars - 1)
  const out: [bigint, bigint][][] = []

  for (const s of lower) {
    const fibres = fibrePolys(set, nvars, s)
    const product = uniProduct(fibres)
    const fibreSamples =
      product.length <= 1 ? [[0n, 1n] as [bigint, bigint]] : cellSamplesBig(product)

    for (const fs of fibreSamples) {
      out.push([...s, fs])
    }
  }

  return out
}

// a single-variable polynomial as an integer coefficient list (index = power of its one variable)
function fibreUnivariate(p: NPoly): bigint[] {
  let deg = 0
  const byPower = new Map<number, bigint>()

  for (const [k, c] of p) {
    const e = exps(k)
    const power = e[0] ?? 0
    byPower.set(power, (byPower.get(power) ?? 0n) + c)
    deg = Math.max(deg, power)
  }

  const out: bigint[] = new Array(deg + 1).fill(0n)

  for (const [power, c] of byPower) {
    out[power] = c
  }

  return trimUni(out)
}

// the value of `p` at a full rational assignment, as a rational
function evalAt(p: NPoly, point: [bigint, bigint][]): Rat {
  let acc = rat(0n)

  for (const [k, c] of p) {
    const e = exps(k)
    let term = rat(c)

    for (let w = 0; w < e.length; w++) {
      for (let t = 0; t < e[w]!; t++) {
        term = rmul(term, rat(point[w]![0], point[w]![1]))
      }
    }

    acc = radd(acc, term)
  }

  return acc
}

// is `p(x_0, ..., x_{nvars-1}) >= 0` for ALL real arguments? The n-variable CAD decision.
export function nonNegativeEverywhereNvar(p: NPoly, nvars: number): boolean {
  if (isZero(p)) {
    return true
  }

  if (nvars === 1) {
    // defer to the exact univariate cell decision
    const product = fibreUnivariate(p)
    const samples = product.length <= 1 ? [[0n, 1n] as [bigint, bigint]] : cellSamplesBig(product)

    for (const s of samples) {
      if (evalAt(p, [s]).n < 0n) {
        return false
      }
    }

    return true
  }

  for (const sample of cadSamples([p], nvars)) {
    if (evalAt(p, sample).n < 0n) {
      return false
    }
  }

  return true
}

// build an NPoly from a list of `[exponentTuple, coefficient]` terms (each tuple of length nvars)
export function nPoly(terms: [number[], bigint][]): NPoly {
  const out: NPoly = new Map()

  for (const [e, c] of terms) {
    addTerm(out, key(e), c)
  }

  return out
}
