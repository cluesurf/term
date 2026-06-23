// Univariate real-arithmetic decision via STURM'S THEOREM -- the one-dimensional base case of cylindrical algebraic
// decomposition (CAD). A real polynomial is the coefficient list `p[i]` = coefficient of `x^i` (integer coefficients).
// The Sturm sequence (the polynomial, its derivative, and the negated polynomial remainders) counts the EXACT number of
// distinct real roots in an interval by the difference of its sign variations at the endpoints. From it every univariate
// sign condition is decided: the count of roots in `(a, b]`, root ISOLATION into disjoint rational intervals, the
// sign-invariant CELL decomposition of the real line, and from those `p > 0 everywhere`, `p >= 0 everywhere` (complete,
// including the touching-zero cases), and `p > 0 on (a, b)`.
//
// All arithmetic is EXACT: coefficients and sample points are BigInt rationals, so a sign is never a rounded float near
// a root. This is the sign-invariant decomposition of the real line that CAD lifts to many variables. Browser-safe.

export type Poly = number[]

// ===== exact BigInt rationals =====

type Rat = { n: bigint; d: bigint } // d > 0, gcd(n, d) = 1

function bigAbs(a: bigint): bigint {
  return a < 0n ? -a : a
}

function bigGcd(a: bigint, b: bigint): bigint {
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

  const g = bigGcd(n, d) || 1n

  return { n: n / g, d: d / g }
}

const RZERO = rat(0n)
const RONE = rat(1n)

function radd(x: Rat, y: Rat): Rat {
  return rat(x.n * y.d + y.n * x.d, x.d * y.d)
}

function rsub(x: Rat, y: Rat): Rat {
  return rat(x.n * y.d - y.n * x.d, x.d * y.d)
}

function rmul(x: Rat, y: Rat): Rat {
  return rat(x.n * y.n, x.d * y.d)
}

function rinv(x: Rat): Rat {
  return rat(x.d, x.n)
}

function rsign(x: Rat): number {
  return x.n > 0n ? 1 : x.n < 0n ? -1 : 0
}

function rabs(x: Rat): Rat {
  return x.n < 0n ? { n: -x.n, d: x.d } : x
}

// x < y  ?  (both denominators positive)
function rlt(x: Rat, y: Rat): boolean {
  return x.n * y.d < y.n * x.d
}

function rmax(x: Rat, y: Rat): Rat {
  return rlt(x, y) ? y : x
}

const HALF = rat(1n, 2n)

// ===== exact polynomials over the rationals (index = power) =====

type RPoly = Rat[]

function rtrim(p: RPoly): RPoly {
  let n = p.length

  while (n > 0 && p[n - 1]!.n === 0n) {
    n--
  }

  return p.slice(0, n)
}

function toRPoly(p: Poly): RPoly {
  return rtrim(p.map(c => rat(BigInt(Math.round(c)))))
}

function rEval(p: RPoly, x: Rat): Rat {
  let acc = RZERO

  for (let i = p.length - 1; i >= 0; i--) {
    acc = radd(rmul(acc, x), p[i]!)
  }

  return acc
}

function rDeriv(p: RPoly): RPoly {
  const d: RPoly = []

  for (let i = 1; i < p.length; i++) {
    d.push(rmul(p[i]!, rat(BigInt(i))))
  }

  return rtrim(d)
}

function rScale(p: RPoly, s: Rat): RPoly {
  return p.map(c => rmul(c, s))
}

function rSubPoly(a: RPoly, b: RPoly): RPoly {
  const n = Math.max(a.length, b.length)
  const out: RPoly = []

  for (let i = 0; i < n; i++) {
    out.push(rsub(a[i] ?? RZERO, b[i] ?? RZERO))
  }

  return rtrim(out)
}

// the remainder of dividing `a` by `b` (exact rational polynomial long division)
function rRemainder(a: RPoly, b: RPoly): RPoly {
  let r = rtrim(a)
  const bb = rtrim(b)
  const db = bb.length - 1
  const lead = bb[db]!

  while (r.length - 1 >= db && r.length > 0) {
    const dr = r.length - 1
    const factor = rmul(r[dr]!, rinv(lead))
    const shift = dr - db
    const term: RPoly = new Array(shift).fill(RZERO).concat(rScale(bb, factor))
    r = rSubPoly(r, term)

    if (r.length - 1 >= dr) {
      r = rtrim(r.slice(0, dr))
    }
  }

  return rtrim(r)
}

// the Sturm sequence of `p`: p_0 = p, p_1 = p', p_{i+1} = -(p_{i-1} mod p_i), to the last nonzero remainder.
function rSturmSequence(p: RPoly): RPoly[] {
  const seq: RPoly[] = [rtrim(p)]
  const d = rDeriv(p)

  if (d.length === 0) {
    return seq
  }

  seq.push(d)

  while (true) {
    const prev = seq[seq.length - 2]!
    const cur = seq[seq.length - 1]!
    const rem = rRemainder(prev, cur)

    if (rem.length === 0) {
      break
    }

    seq.push(rScale(rem, rat(-1n)))
  }

  return seq
}

// the number of sign variations in the Sturm sequence evaluated at `x` (zeros skipped)
function rSignVariations(seq: RPoly[], x: Rat): number {
  let last = 0
  let count = 0

  for (const poly of seq) {
    const s = rsign(rEval(poly, x))

    if (s !== 0) {
      if (last !== 0 && s !== last) {
        count++
      }

      last = s
    }
  }

  return count
}

// a Cauchy bound `M` (rational) with all real roots of `p` strictly inside `(-M, M)`, and `p(±M) != 0`.
function rRootBound(p: RPoly): Rat {
  const t = rtrim(p)
  const lead = rabs(t[t.length - 1]!)
  let m = RZERO

  for (let i = 0; i < t.length - 1; i++) {
    m = rmax(m, rmul(rabs(t[i]!), rinv(lead)))
  }

  let bound = radd(m, RONE)

  // make sure the bound itself is not a root (so endpoints stay clean)
  while (rsign(rEval(t, bound)) === 0 || rsign(rEval(t, { n: -bound.n, d: bound.d })) === 0) {
    bound = radd(bound, RONE)
  }

  return bound
}

// isolate the DISTINCT real roots of `p` into disjoint open rational intervals, each containing exactly one root and
// with non-root endpoints. Sorted by left endpoint.
function rIsolateRoots(p: RPoly): [Rat, Rat][] {
  const s = rtrim(p)

  if (s.length <= 1) {
    return []
  }

  const seq = rSturmSequence(s)
  const bound = rRootBound(s)
  const variationsAt = (x: Rat): number => rSignVariations(seq, x)

  const out: [Rat, Rat][] = []
  const queue: [Rat, Rat][] = [[{ n: -bound.n, d: bound.d }, bound]]
  let guard = 0

  while (queue.length > 0 && guard++ < 200000) {
    const [a, b] = queue.shift()!
    const count = variationsAt(a) - variationsAt(b) // roots in (a, b]

    if (count <= 0) {
      continue
    }

    if (count === 1) {
      out.push([a, b])
      continue
    }

    // split at a NON-root midpoint (keeps every interval endpoint off the roots)
    let m = rmul(radd(a, b), HALF)
    let tries = 0

    while (rsign(rEval(s, m)) === 0 && tries++ < 64) {
      m = rmul(radd(a, m), HALF)
    }

    queue.push([a, m])
    queue.push([m, b])
  }

  out.sort((x, y) => (rlt(x[0], y[0]) ? -1 : 1))

  return out
}

// the sign-invariant CELL decomposition: a sample point (rational) in each open interval between consecutive distinct
// roots, plus one left of all roots and one right of all roots. `p` has a constant sign on each cell, equal to its sign
// at the sample. (The roots themselves are the zero-cells.) This is the one-dimensional CAD.
function rCellSamples(p: RPoly): Rat[] {
  const intervals = rIsolateRoots(p)

  if (intervals.length === 0) {
    return [RZERO] // no roots: the sign is constant, sample anywhere
  }

  const samples: Rat[] = [rsub(intervals[0]![0], RONE)] // left of the smallest root

  for (const [, b] of intervals) {
    samples.push(b) // b_i lies strictly between root_i and root_{i+1} (or right of the largest root)
  }

  return samples
}

// ===== public number[] interface =====

export function degree(p: Poly): number {
  return toRPoly(p).length - 1
}

export function evaluate(p: Poly, x: number): number {
  // exact when x is an integer; used by tests for an integer sample
  const v = rEval(toRPoly(p), rat(BigInt(Math.round(x))))

  return Number(v.n) / Number(v.d)
}

export function derivative(p: Poly): Poly {
  return rDeriv(toRPoly(p)).map(c => Number(c.n) / Number(c.d))
}

// the number of DISTINCT real roots of `p` in the half-open interval `(a, b]`
export function rootCountIn(p: Poly, a: number, b: number): number {
  const seq = rSturmSequence(toRPoly(p))

  return (
    rSignVariations(seq, rat(BigInt(Math.round(a)))) -
    rSignVariations(seq, rat(BigInt(Math.round(b))))
  )
}

// the total number of DISTINCT real roots of `p`
export function realRootCount(p: Poly): number {
  const t = toRPoly(p)

  if (t.length <= 1) {
    return 0
  }

  const seq = rSturmSequence(t)
  const bound = rRootBound(t)

  return (
    rSignVariations(seq, { n: -bound.n, d: bound.d }) -
    rSignVariations(seq, bound)
  )
}

// does `p` have at least one real root?
export function hasRealRoot(p: Poly): boolean {
  return realRootCount(p) > 0
}

// does `p(x) > 0` for ALL real x? (strictly positive: no real root, positive sign)
export function positiveEverywhere(p: Poly): boolean {
  const t = toRPoly(p)

  if (t.length === 0) {
    return false // the zero polynomial is not strictly positive
  }

  if (realRootCount(p) > 0) {
    return false
  }

  // no real roots: the sign is constant, read it at any point
  return rsign(rEval(t, RZERO)) > 0 || rsign(rEval(t, rRootBound(t))) > 0
}

// does `p(x) >= 0` for ALL real x? COMPLETE: it samples every cell of the sign-invariant decomposition, so it accepts
// the touching-zero non-negative polynomials (e.g. `(x-1)^2 (x-2)^2`) that strict positivity cannot, and rejects any
// polynomial that dips below zero on some interval.
export function nonNegativeEverywhere(p: Poly): boolean {
  const t = toRPoly(p)

  if (t.length === 0) {
    return true // the zero polynomial is >= 0 everywhere
  }

  for (const x of rCellSamples(t)) {
    if (rsign(rEval(t, x)) < 0) {
      return false
    }
  }

  return true
}

// the CELL sample points of the sign-invariant decomposition of the real line by `p`, as exact rationals `[num, den]`
// (one rational strictly inside each open interval between consecutive distinct roots, plus one left of all and one
// right of all). `p` has a constant sign on each cell. This is the one-dimensional CAD, exported for the multivariate
// lift (`cad.ts`): a cell of the base line lifts to a stack of cells in the variable above it.
export function cellSamples(p: Poly): [bigint, bigint][] {
  return rCellSamples(toRPoly(p)).map(r => [r.n, r.d] as [bigint, bigint])
}

// the same, for a polynomial whose integer coefficients are EXACT BigInts (they can exceed 2^53 after the multivariate
// projection multiplies several polynomials, so they must not pass through a float).
export function cellSamplesBig(coefficients: bigint[]): [bigint, bigint][] {
  return rCellSamples(rtrim(coefficients.map(c => rat(c)))).map(
    r => [r.n, r.d] as [bigint, bigint],
  )
}

// is the polynomial with the given EXACT RATIONAL coefficients (`[num, den]` per power) non-negative for all reals? The
// multivariate lift forms a fibre polynomial by substituting a rational sample point, whose coefficients are rationals;
// this decides that fibre completely without a lossy conversion to floats.
export function rationalNonNegativeEverywhere(
  coefficients: [bigint, bigint][],
): boolean {
  const t = rtrim(coefficients.map(([n, d]) => rat(n, d)))

  if (t.length === 0) {
    return true
  }

  for (const x of rCellSamples(t)) {
    if (rsign(rEval(t, x)) < 0) {
      return false
    }
  }

  return true
}

// does `p(x) > 0` for all x in the OPEN interval `(a, b)`? Bounded-quantifier sign decision: true iff `p` has no root in
// `(a, b)` (an interior root would make it zero, and a sign change would make it negative) and `p` is positive at the
// midpoint. Sound for a < b.
export function positiveOnInterval(p: Poly, a: number, b: number): boolean {
  const t = toRPoly(p)
  const lo = rat(BigInt(Math.round(a)))
  const hi = rat(BigInt(Math.round(b)))
  const seq = rSturmSequence(t)
  // roots in (a, b]; subtract a root exactly at b (allowed, the interval is open at b)
  const rootsHalfOpen =
    rSignVariations(seq, lo) - rSignVariations(seq, hi)
  const bIsRoot = rsign(rEval(t, hi)) === 0 ? 1 : 0
  const interiorRoots = rootsHalfOpen - bIsRoot

  if (interiorRoots > 0) {
    return false
  }

  // no interior root: the sign is constant on (a, b); read it at the midpoint
  return rsign(rEval(t, rmul(radd(lo, hi), HALF))) > 0
}

// ===== the STURM-TARSKI query: sign determination at the real roots of a polynomial =====

function rMulPoly(a: RPoly, b: RPoly): RPoly {
  if (a.length === 0 || b.length === 0) {
    return []
  }

  const out: RPoly = new Array(a.length + b.length - 1).fill(RZERO)

  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      out[i + j] = radd(out[i + j]!, rmul(a[i]!, b[j]!))
    }
  }

  return rtrim(out)
}

// the sign of a polynomial as its argument runs to +infinity (the sign of its leading coefficient) or to -infinity (the
// leading sign times (-1)^degree). The zero polynomial has sign 0 at both ends.
function signAtInfinity(p: RPoly, positive: boolean): number {
  if (p.length === 0) {
    return 0
  }

  const lead = rsign(p[p.length - 1]!)

  if (positive) {
    return lead
  }

  return (p.length - 1) % 2 === 0 ? lead : -lead
}

function infinityVariations(seq: RPoly[], positive: boolean): number {
  let last = 0
  let count = 0

  for (const poly of seq) {
    const s = signAtInfinity(poly, positive)

    if (s !== 0) {
      if (last !== 0 && s !== last) {
        count++
      }

      last = s
    }
  }

  return count
}

// the generalized (signed-remainder) Sturm sequence of `f` and `g`: f_0 = f, f_1 = g, f_{i+1} = -(f_{i-1} mod f_i).
function rSignedRemainderSequence(f: RPoly, g: RPoly): RPoly[] {
  const seq: RPoly[] = [rtrim(f)]

  if (rtrim(g).length === 0) {
    return seq
  }

  seq.push(rtrim(g))

  while (true) {
    const prev = seq[seq.length - 2]!
    const cur = seq[seq.length - 1]!
    const rem = rRemainder(prev, cur)

    if (rem.length === 0) {
      break
    }

    seq.push(rScale(rem, rat(-1n)))
  }

  return seq
}

// the STURM-TARSKI query TaQ(g, f) = sum over the distinct real roots `x` of `f` of `sign(g(x))`. It is computed from
// the signed-remainder sequence of `f` and `f' * g` by the difference of its sign variations at -infinity and
// +infinity -- so it reads off the signs of `g` at the (possibly irrational) roots of `f` WITHOUT computing them. This
// is the engine of Tarski's decidability of the reals: it counts real roots of `f` weighted by where `g` is positive
// or negative, the exact information a cylindrical decomposition needs to lift a cell through an algebraic point.
function tarskiQueryR(g: RPoly, f: RPoly): number {
  const seq = rSignedRemainderSequence(f, rMulPoly(rDeriv(f), g))

  return infinityVariations(seq, false) - infinityVariations(seq, true)
}

export function tarskiQuery(g: Poly, f: Poly): number {
  return tarskiQueryR(toRPoly(g), toRPoly(f))
}

// the number of distinct real roots of `f` at which `g` is positive, negative, and zero, by combining three Tarski
// queries: TaQ(1) = the root count, TaQ(g) = #(g>0) - #(g<0), TaQ(g^2) = #(g>0) + #(g<0). Exact, no root computation.
export function realRootsBySign(g: Poly, f: Poly): {
  positive: number
  negative: number
  zero: number
} {
  const gPoly = toRPoly(g)
  const fPoly = toRPoly(f)
  const total = tarskiQueryR([RONE], fPoly)
  const single = tarskiQueryR(gPoly, fPoly)
  const square = tarskiQueryR(rMulPoly(gPoly, gPoly), fPoly)

  const positive = (single + square) / 2
  const negative = (square - single) / 2

  return { positive, negative, zero: total - square }
}
