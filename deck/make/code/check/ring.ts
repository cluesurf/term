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
  const parts: string[] = []

  for (const [v, p] of [...powers].sort((a, b) =>
    a[0] < b[0] ? -1 : 1,
  )) {
    if (p > 0) {
      parts.push(p === 1 ? v : `${v}^${p}`)
    }
  }

  return parts.join('*')
}

// parsed monomial keys are cached: a polynomial multiply re-touches the same keys O(n^2) times, and parsing a key
// (`a^2*b`) into its (variable, power) pairs is pure string work, so memoizing it removes the dominant cost of the big
// norm identities (the octonion eight-square has thousands of monomial products). The cache holds immutable entry
// arrays; monoPowers builds a FRESH mutable Map per call from them, so callers that mutate the result (mulPoly) never
// corrupt the cache.
const monoEntriesCache = new Map<string, [string, number][]>()

function monoEntries(key: string): [string, number][] {
  let entries = monoEntriesCache.get(key)

  if (entries) {
    return entries
  }

  entries = []

  if (key !== '') {
    for (const factor of key.split('*')) {
      const [v, p] = factor.split('^')
      entries.push([v!, p ? Number(p) : 1])
    }
  }

  monoEntriesCache.set(key, entries)

  return entries
}

// the variable powers of a monomial key (a fresh, mutable map)
function monoPowers(key: string): Map<string, number> {
  const powers = new Map<string, number>()

  for (const [v, p] of monoEntries(key)) {
    powers.set(v, (powers.get(v) ?? 0) + p)
  }

  return powers
}

function addInto(poly: Poly, key: string, coeff: number): void {
  const next = (poly.get(key) ?? 0) + coeff

  if (next === 0) {
    poly.delete(key)
  } else {
    poly.set(key, next)
  }
}

function addPoly(a: Poly, b: Poly): Poly {
  const out: Poly = new Map(a)

  for (const [k, c] of b) {
    addInto(out, k, c)
  }

  return out
}

function scalePoly(a: Poly, k: number): Poly {
  const out: Poly = new Map()

  for (const [m, c] of a) {
    out.set(m, c * k)
  }

  return out
}

function mulPoly(a: Poly, b: Poly): Poly {
  const out: Poly = new Map()

  for (const [ma, ca] of a) {
    for (const [mb, cb] of b) {
      const powers = monoPowers(ma)

      for (const [v, p] of monoPowers(mb)) {
        powers.set(v, (powers.get(v) ?? 0) + p)
      }

      addInto(out, monoKey(powers), ca * cb)
    }
  }

  return out
}

function toPoly(expr: Expression): Poly | null {
  switch (expr.form) {
    case 'integer': {
      const n = Number(expr.value)

      if (!Number.isInteger(n)) {
        return null
      }

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

      if (!l || !r) {
        return null
      }

      if (expr.op === '+') {
        return addPoly(l, r)
      }

      if (expr.op === '-') {
        return addPoly(l, scalePoly(r, -1))
      }

      if (expr.op === '*') {
        return mulPoly(l, r)
      }

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

  if (!l || !r) {
    return false
  }

  return addPoly(l, scalePoly(r, -1)).size === 0
}

// is a polynomial MANIFESTLY non-negative: a non-negative constant plus a sum of square monomials (every variable
// power even, with a non-negative coefficient)? Sound: such a polynomial is at least zero for all integer values,
// since each term is a non-negative coefficient times a perfect square. Incomplete (it does not search for a general
// sum-of-squares decomposition, so it misses e.g. a*a - 2*a*b + b*b = (a-b)^2), but it is decidable and covers "every
// square is non-negative" and sums of squares.
function polyNonNegative(d: Poly): boolean {
  for (const [mono, coeff] of d) {
    if (coeff < 0) {
      return false
    }

    for (const power of monoPowers(mono).values()) {
      if (power % 2 !== 0) {
        return false
      }
    }
  }

  return true
}

// ---- exact rationals (BigInt), so the sum-of-squares test below is sound, never a floating-point guess ----
type Rat = { n: bigint; d: bigint }

function bgcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b

  while (b) {
    ;[a, b] = [b, a % b]
  }

  return a
}

function rat(n: bigint, d = 1n): Rat {
  if (d < 0n) {
    n = -n
    d = -d
  }

  const g = bgcd(n, d) || 1n

  return { n: n / g, d: d / g }
}

const ratAdd = (a: Rat, b: Rat): Rat =>
  rat(a.n * b.d + b.n * a.d, a.d * b.d)

const ratSub = (a: Rat, b: Rat): Rat =>
  rat(a.n * b.d - b.n * a.d, a.d * b.d)

const ratMul = (a: Rat, b: Rat): Rat => rat(a.n * b.n, a.d * b.d)
const ratDiv = (a: Rat, b: Rat): Rat => rat(a.n * b.d, a.d * b.n)
const ratNeg = (r: Rat): boolean => r.n < 0n
const ratZero = (r: Rat): boolean => r.n === 0n

// decide whether a symmetric rational matrix is positive semidefinite, by LDL congruence (symmetric Gaussian
// elimination). Sound: a negative pivot exposes a 1-D direction of negative value; a zero pivot with any nonzero in
// its remaining row exposes a 2x2 indefinite minor. All pivots non-negative (zero pivots having zero rows) means the
// matrix is congruent to a non-negative diagonal, hence PSD.
function symmetricPositiveSemidefinite(m: Rat[][]): boolean {
  const n = m.length

  for (let i = 0; i < n; i++) {
    const pivot = m[i]![i]!

    if (ratNeg(pivot)) {return false}

    if (ratZero(pivot)) {
      for (let j = i + 1; j < n; j++)
        {if (!ratZero(m[i]![j]!)) {return false}}

      continue
    }

    for (let j = i + 1; j < n; j++) {
      const factor = ratDiv(m[i]![j]!, pivot)

      for (let k = j; k < n; k++) {
        m[j]![k] = ratSub(m[j]![k]!, ratMul(factor, m[i]![k]!))
        m[k]![j] = m[j]![k]!
      }
    }
  }

  return true
}

// decide whether a polynomial of total degree at most two is non-negative for ALL real (hence integer) values, by
// testing that its Gram matrix over the variables {1, x1, .., xk} is positive semidefinite. A PSD Gram matrix means
// the polynomial is a sum of squares of linear forms, which is non-negative everywhere. This proves a*a - 2*a*b + b*b
// >= 0 (the (a - b)^2 the manifest test misses), n*n - 2*n + 1 >= 0, and every other quadratic inequality. Declines
// (returns false) on any monomial of total degree above two, leaving such goals to the manifest test.
function quadraticFormNonNegative(d: Poly): boolean {
  const vars: string[] = []

  const indexOf = (v: string): number => {
    let i = vars.indexOf(v)

    if (i < 0) {
      i = vars.length
      vars.push(v)
    }

    return i
  }

  // first pass: register variables and reject any total degree above two
  for (const mono of d.keys()) {
    let degree = 0

    for (const [v, p] of monoPowers(mono)) {
      degree += p
      indexOf(v)
    }

    if (degree > 2) {return false}
  }

  const size = vars.length + 1 // slot 0 is the constant 1
  const m: Rat[][] = Array.from({ length: size }, () =>
    Array.from({ length: size }, () => rat(0n)),
  )

  const put = (a: number, b: number, value: Rat): void => {
    m[a]![b] = ratAdd(m[a]![b]!, value)

    if (a !== b) {m[b]![a] = ratAdd(m[b]![a]!, value)}
  }

  const half = (c: number): Rat => rat(BigInt(c), 2n)

  for (const [mono, coeff] of d) {
    const powers = [...monoPowers(mono)]

    if (powers.length === 0)
      {put(0, 0, rat(BigInt(coeff)))} // constant term
    else if (powers.length === 1) {
      const [v, p] = powers[0]!
      const i = indexOf(v) + 1

      if (p === 1)
        {put(0, i, half(coeff))} // linear term: coeff/2 off the constant row
      else {put(i, i, rat(BigInt(coeff)))} // square term x_i^2: the i-th diagonal
    } else {
      // a cross term x_i x_j (both powers 1): coeff/2 in the symmetric off-diagonal
      const i = indexOf(powers[0]![0]) + 1
      const j = indexOf(powers[1]![0]) + 1
      put(i, j, half(coeff))
    }
  }

  return symmetricPositiveSemidefinite(m)
}

// decide `left >= right` for ALL values by showing left - right is non-negative everywhere: either manifestly (a sum
// of square monomials plus a non-negative constant, which also covers high even powers like x^4), or as a quadratic
// form whose Gram matrix is positive semidefinite (which covers (a - b)^2 and every quadratic inequality). Proves
// "n*n >= 0", "a*a + b*b >= 2*a*b", and the like, which the linear prover (degree one) cannot. False when neither holds
// or the goal falls outside the +/-/* integer fragment.
export function nonNegativeDifference(
  left: Expression,
  right: Expression,
): boolean {
  const l = toPoly(left)
  const r = toPoly(right)

  if (!l || !r) {
    return false
  }

  const diff = addPoly(l, scalePoly(r, -1))

  return polyNonNegative(diff) || quadraticFormNonNegative(diff)
}
