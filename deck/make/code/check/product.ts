// NONLINEAR ARITHMETIC BY PRODUCTS OF HYPOTHESES: the step the linear prover cannot take, `y >= 0` and `x*x <= y*y`
// give `x <= y`. It is the Positivstellensatz of degree two, the procedure Lean calls `nlinarith`:
//
//   1. the facts are polynomials known `>= 0`, `> 0` or `== 0`, and the goal's NEGATION is added as one more fact;
//   2. every product of two facts is a fact too (a product of non-negatives is non-negative, of positives positive,
//      and anything times zero is zero), and so is every square of a variable;
//   3. each monomial is read as an unknown of its own, and a linear program looks for non-negative multipliers whose
//      combination of the facts is IDENTICALLY a negative constant, or identically zero with a strict fact used.
//
// Either is impossible (a sum of non-negatives is not -1, a sum with a positive part is not 0), so the facts cannot
// all hold, so the goal follows. The multipliers are the CERTIFICATE. The search is an exact simplex over rationals,
// and what it returns is replayed by `replay` below, which recomputes the combination from the facts and shares
// nothing with the search but the polynomial arithmetic. A wrong search can cost a proof and never forge one.
//
// There is NO integer tightening here, unlike refine.ts: every step is valid in an ordered field, so a goal proven
// here holds over the rationals and the reals, not only over the integers the variables are typed as.

// a polynomial: monomial key (variable names, sorted, joined by NUL as in holds.ts, '' for the constant) -> rational
export type Polynomial = Map<string, Rational>

export type Rational = { n: bigint; d: bigint }

export type Fact = { polynomial: Polynomial; relation: 'nonnegative' | 'positive' | 'zero' }

// ---- exact rationals ----

const gcd = (a: bigint, b: bigint): bigint => {
  a = a < 0n ? -a : a
  b = b < 0n ? -b : b

  while (b) {
    ;[a, b] = [b, a % b]
  }

  return a
}

export function rational(n: bigint, d = 1n): Rational {
  if (d === 0n) {
    throw new Error('rational with denominator zero')
  }

  if (d < 0n) {
    n = -n
    d = -d
  }

  const g = gcd(n, d) || 1n

  return { n: n / g, d: d / g }
}

const ZERO = rational(0n)
const ONE = rational(1n)
const plus = (a: Rational, b: Rational): Rational => rational(a.n * b.d + b.n * a.d, a.d * b.d)
const minus = (a: Rational, b: Rational): Rational => rational(a.n * b.d - b.n * a.d, a.d * b.d)
const times = (a: Rational, b: Rational): Rational => rational(a.n * b.n, a.d * b.d)
const over = (a: Rational, b: Rational): Rational => rational(a.n * b.d, a.d * b.n)
const isZero = (a: Rational): boolean => a.n === 0n
const sign = (a: Rational): number => (a.n > 0n ? 1 : a.n < 0n ? -1 : 0)
const below = (a: Rational, b: Rational): boolean => a.n * b.d < b.n * a.d

// ---- polynomials ----

const SEPARATOR = '\u0000'
const vars = (key: string): string[] => (key === '' ? [] : key.split(SEPARATOR))
const join = (a: string, b: string): string => [...vars(a), ...vars(b)].sort().join(SEPARATOR)

export function multiply(a: Polynomial, b: Polynomial): Polynomial {
  const out: Polynomial = new Map()

  for (const [ka, ca] of a) {
    for (const [kb, cb] of b) {
      const key = join(ka, kb)
      out.set(key, plus(out.get(key) ?? ZERO, times(ca, cb)))
    }
  }

  return clean(out)
}

function scaled(a: Polynomial, k: Rational): Polynomial {
  const out: Polynomial = new Map()

  for (const [key, c] of a) {
    out.set(key, times(c, k))
  }

  return clean(out)
}

function sum(a: Polynomial, b: Polynomial): Polynomial {
  const out: Polynomial = new Map(a)

  for (const [key, c] of b) {
    out.set(key, plus(out.get(key) ?? ZERO, c))
  }

  return clean(out)
}

function clean(a: Polynomial): Polynomial {
  return new Map([...a].filter(([, c]) => !isZero(c)))
}

const degree = (a: Polynomial): number => Math.max(0, ...[...a.keys()].map(k => vars(k).length))

// ---- the certificate and its replay ----

// one row of the certificate: a fact, or a product of two or three facts, or a square of a variable, and its multiplier
type Row = {
  polynomial: Polynomial
  // a row known `== 0` takes a multiplier of either sign, the others a non-negative one
  relation: 'nonnegative' | 'positive' | 'zero'
  // how the row was made, which is what `replay` rebuilds it from
  // `square: [v]` is v^2, `square: [v, w]` is (v - w)^2 and `square: [v, w, '+']` is (v + w)^2
  // `{ fact, times }` is an EQUATION fact times a monomial, which is still an equation (the ideal it generates)
  // `{ fact, square }` is an INEQUALITY fact times the square of a variable, which keeps its sign
  from: { fact: number; times?: string; square?: string } | { facts: number[] } | { square: string[] }
}

export type Certificate = { rows: Row['from'][]; multipliers: Rational[] }

function rebuild(from: Row['from'], facts: Fact[]): Row | undefined {
  if ('fact' in from) {
    const fact = facts[from.fact]

    if (!fact) {
      return undefined
    }

    if (from.times !== undefined && from.square !== undefined) {
      return undefined
    }

    if (from.square !== undefined) {
      const v: Polynomial = new Map([[from.square, ONE]])

      // a positive fact times a square is only non-negative (the square may be zero)
      return {
        polynomial: multiply(fact.polynomial, multiply(v, v)),
        relation: fact.relation === 'zero' ? 'zero' : 'nonnegative',
        from,
      }
    }

    if (from.times === undefined) {
      return { polynomial: fact.polynomial, relation: fact.relation, from }
    }

    // only an equation may be multiplied by an arbitrary monomial: x >= 0 times -1 is not >= 0
    if (fact.relation !== 'zero') {
      return undefined
    }

    return { polynomial: multiply(fact.polynomial, new Map([[from.times, ONE]])), relation: 'zero', from }
  }

  if ('square' in from && Array.isArray(from.square)) {
    const [v, w, plus] = from.square

    if (!v || from.square.length > 3 || (plus !== undefined && plus !== '+')) {
      return undefined
    }

    const base: Polynomial = new Map([[v, ONE]])

    // `w` is a second variable, or '1' for the constant one (no variable is named '1'): (v - 1)^2, (v + 1)^2
    if (w !== undefined) {
      base.set(w === '1' ? '' : w, plus === '+' ? ONE : rational(-1n))
    }

    return { polynomial: multiply(base, base), relation: 'nonnegative', from }
  }

  if (!('facts' in from) || from.facts.length < 2 || from.facts.length > 3) {
    return undefined
  }

  const factors = from.facts.map(i => facts[i])

  if (factors.some(f => !f)) {
    return undefined
  }

  // anything times zero is zero, positives multiply to a positive, and otherwise the product is non-negative
  const relation = factors.some(f => f!.relation === 'zero')
    ? 'zero'
    : factors.every(f => f!.relation === 'positive')
      ? 'positive'
      : 'nonnegative'

  const polynomial = factors.slice(1).reduce((acc, f) => multiply(acc, f!.polynomial), factors[0]!.polynomial)

  return { polynomial, relation, from }
}

// THE CHECKER. The facts cannot all hold when the certificate's combination of them is identically a negative
// constant, or identically zero with a positive multiplier on a strict row. Nothing from the search is trusted but
// the row recipes and the multipliers, and both are checked here.
export function replay(facts: Fact[], certificate: Certificate): boolean {
  if (certificate.rows.length !== certificate.multipliers.length) {
    return false
  }

  let total: Polynomial = new Map()
  let strictUsed = false

  for (let i = 0; i < certificate.rows.length; i++) {
    const row = rebuild(certificate.rows[i]!, facts)
    const k = certificate.multipliers[i]!

    if (!row) {
      return false
    }

    if (row.relation !== 'zero' && sign(k) < 0) {
      return false
    }

    if (row.relation === 'positive' && sign(k) > 0) {
      strictUsed = true
    }

    total = sum(total, scaled(row.polynomial, k))
  }

  for (const key of total.keys()) {
    if (key !== '') {
      return false
    }
  }

  const constant = total.get('') ?? ZERO

  return sign(constant) < 0 || (isZero(constant) && strictUsed)
}

// ---- the search ----

// the rows: every fact, every product of two facts, every product of the FOCUS (the negated goal) with two facts, and
// the square of every variable they mention. The triples are what a square-root step whose root is itself a product
// needs: `(s t) >= 0` and `x^2 <= (s t)^2` give `x <= s t` through `s t (s t - x)`, a product of three.
// the LINEAR mode: the facts combined with non-negative multipliers and no products, except that an equation may be
// multiplied by each of `multipliers` (the caller names them: an equation times anything is an equation)
export type LinearMode = { multipliers: string[] }

function rowsOf(facts: Fact[], focus?: number, linear?: LinearMode): Row[] {
  const rows: Row[] = []
  const variables = new Set<string>()

  for (let i = 0; i < facts.length; i++) {
    rows.push({ ...facts[i]!, from: { fact: i } })

    for (const key of facts[i]!.polynomial.keys()) {
      vars(key).forEach(v => variables.add(v))
    }
  }

  // the LINEAR mode: the facts themselves, combined with non-negative rational multipliers and nothing multiplied.
  // Farkas' lemma over an ordered field, for the many-facts case (instantiated hypotheses) where products would be
  // too many rows
  if (linear) {
    // so `c(n + 1, 0) = u(0) v(n + 1)` may enter as `(n + 1) c(n + 1, 0) = (n + 1) u(0) v(n + 1)` when n is a multiplier
    const multipliers = [...new Set(linear.multipliers)].sort()

    facts.forEach((fact, i) => {
      if (fact.relation === 'zero') {
        for (const v of multipliers) {
          rows.push(rebuild({ fact: i, times: v }, facts)!)
        }
      }
    })

    return rows
  }

  for (let i = 0; i < facts.length; i++) {
    for (let j = i; j < facts.length; j++) {
      const row = rebuild({ facts: [i, j] }, facts)

      if (row && row.polynomial.size > 0) {
        rows.push(row)
      }
    }
  }

  if (focus !== undefined && facts[focus]) {
    for (let i = 0; i < facts.length; i++) {
      for (let j = i; j < facts.length; j++) {
        const row = rebuild({ facts: [focus, i, j] }, facts)

        if (row && row.polynomial.size > 0 && degree(row.polynomial) <= 6) {
          rows.push(row)
        }
      }
    }
  }

  const sorted = [...variables].sort()

  for (const v of sorted) {
    rows.push(rebuild({ square: [v] }, facts)!)
  }

  // every inequality times the square of every variable (a non-negative times a square stays non-negative), so
  // `m - a^2 >= 0` can be scaled by `v^2` the way a Cauchy-Schwarz step needs
  facts.forEach((fact, i) => {
    if (fact.relation !== 'zero') {
      for (const v of sorted) {
        const row = rebuild({ fact: i, square: v }, facts)

        if (row && degree(row.polynomial) <= 6) {
          rows.push(row)
        }
      }
    }
  })

  // every equation times every monomial of degree one or two, so an equation can be used inside a product
  const monomials = [
    ...sorted,
    ...sorted.flatMap((v, i) => sorted.slice(i).map(w => join(v, w))),
  ]

  facts.forEach((fact, i) => {
    if (fact.relation === 'zero') {
      for (const m of monomials) {
        rows.push(rebuild({ fact: i, times: m }, facts)!)
      }
    }
  })

  // the square of every variable plus or minus one, so `c^2 - c + 1 > 0` (half of (c - 1)^2 plus half of c^2 plus a
  // half) needs no hint
  for (const v of sorted) {
    rows.push(rebuild({ square: [v, '1'] }, facts)!)
    rows.push(rebuild({ square: [v, '1', '+'] }, facts)!)
  }

  // and the square of every sum and difference of two of them, so `a^2 + b^2 >= 2 a b` needs no hint
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      rows.push(rebuild({ square: [sorted[i]!, sorted[j]!] }, facts)!)
      rows.push(rebuild({ square: [sorted[i]!, sorted[j]!, '+'] }, facts)!)
    }
  }

  return rows
}

// THE FAST REFUSAL. Phase one in floating point, run before the exact search: when it ends at an optimum whose sum of
// artificials is clearly above zero, no x >= 0 solves A x = b, and the exact search (up to 5000 pivots over growing
// bigint rationals, which is the half hour a false goal used to take) is skipped. This can only DECLINE: a system it
// calls infeasible gets no certificate, which costs at most a proof, and every certificate still comes from the exact
// search below and is replayed. Anything doubtful (no optimum within the step cap, or an optimum near zero) falls
// through to the exact search, so a feasible system, whose exact optimum is 0, is never declined here.
function plainlyInfeasible(a: Rational[][], b: Rational[]): boolean {
  const m = a.length
  const n = a[0]?.length ?? 0
  const width = n + m
  const value = (r: Rational): number => Number(r.n) / Number(r.d)
  const table: number[][] = []

  for (let i = 0; i < m; i++) {
    const raw = [...a[i]!.map(value), value(b[i]!)]
    // each row scaled to a largest entry of 1, so one tolerance serves every row
    const scale = Math.max(...raw.map(Math.abs)) || 1
    const flip = raw[n]! < 0 ? -1 : 1
    const row = raw.slice(0, n).map(c => (flip * c) / scale)

    for (let j = 0; j < m; j++) {
      row.push(i === j ? 1 : 0)
    }

    row.push((flip * raw[n]!) / scale)

    if (row.some(c => !Number.isFinite(c))) {
      return false
    }

    table.push(row)
  }

  const basis = Array.from({ length: m }, (_, i) => n + i)
  const cost = Array.from({ length: width + 1 }, (_, j) => (j >= n && j < width ? 1 : 0))

  for (let i = 0; i < m; i++) {
    for (let j = 0; j <= width; j++) {
      cost[j] = cost[j]! - table[i]![j]!
    }
  }

  const EPSILON = 1e-9

  for (let step = 0; step < 20000; step++) {
    const enter = cost.findIndex((c, j) => j < width && c < -EPSILON)

    if (enter < 0) {
      // optimal: -cost[width] is the least sum of artificials
      return -cost[width]! > 1e-6
    }

    let leave = -1
    let best = Infinity

    for (let i = 0; i < m; i++) {
      const c = table[i]![enter]!

      if (c > EPSILON) {
        const ratio = table[i]![width]! / c

        if (ratio < best - EPSILON || (Math.abs(ratio - best) <= EPSILON && basis[i]! < basis[leave]!)) {
          best = ratio
          leave = i
        }
      }
    }

    if (leave < 0) {
      // unbounded in phase one cannot happen for a sum of non-negatives: a numerical fault, so no verdict
      return false
    }

    const pivot = table[leave]![enter]!
    table[leave] = table[leave]!.map(c => c / pivot)

    for (let i = 0; i < m; i++) {
      const k = table[i]![enter]!

      if (i !== leave && k !== 0) {
        const lead = table[leave]!
        table[i] = table[i]!.map((c, j) => c - k * lead[j]!)
      }
    }

    const k = cost[enter]!
    const lead = table[leave]!

    for (let j = 0; j <= width; j++) {
      cost[j] = cost[j]! - k * lead[j]!
    }

    basis[leave] = enter
  }

  return false
}

// Phase one of the simplex, exact, with Bland's rule (so it cannot cycle): is there x >= 0 with A x = b? Returns x,
// or undefined. Every row of b is made non-negative first, and one artificial per row starts the basis.
function feasible(a: Rational[][], b: Rational[]): Rational[] | undefined {
  if (plainlyInfeasible(a, b)) {
    return undefined
  }

  const m = a.length
  const n = a[0]?.length ?? 0
  const width = n + m
  const table: Rational[][] = []

  for (let i = 0; i < m; i++) {
    const flip = sign(b[i]!) < 0
    const row = a[i]!.map(c => (flip ? times(c, rational(-1n)) : c))

    for (let j = 0; j < m; j++) {
      row.push(i === j ? ONE : ZERO)
    }

    row.push(flip ? times(b[i]!, rational(-1n)) : b[i]!)
    table.push(row)
  }

  const basis = Array.from({ length: m }, (_, i) => n + i)

  // the objective: minimize the sum of the artificials, carried as reduced costs
  const cost = (): Rational[] => {
    const out = Array.from({ length: width + 1 }, (_, j) => (j >= n && j < width ? ONE : ZERO))

    for (let i = 0; i < m; i++) {
      if (basis[i]! >= n) {
        for (let j = 0; j <= width; j++) {
          out[j] = minus(out[j]!, table[i]![j]!)
        }
      }
    }

    return out
  }

  for (let step = 0; step < 5000; step++) {
    const reduced = cost()
    // Bland: the lowest-indexed column with a negative reduced cost enters
    const enter = reduced.findIndex((c, j) => j < width && sign(c) < 0)

    if (enter < 0) {
      break
    }

    let leave = -1
    let best: Rational | undefined

    for (let i = 0; i < m; i++) {
      const c = table[i]![enter]!

      if (sign(c) > 0) {
        const ratio = over(table[i]![width]!, c)

        if (
          best === undefined ||
          below(ratio, best) ||
          (!below(best, ratio) && basis[i]! < basis[leave]!)
        ) {
          best = ratio
          leave = i
        }
      }
    }

    if (leave < 0) {
      return undefined
    }

    const pivot = table[leave]![enter]!
    table[leave] = table[leave]!.map(c => over(c, pivot))

    for (let i = 0; i < m; i++) {
      if (i !== leave && !isZero(table[i]![enter]!)) {
        const k = table[i]![enter]!
        table[i] = table[i]!.map((c, j) => minus(c, times(k, table[leave]![j]!)))
      }
    }

    basis[leave] = enter
  }

  for (let i = 0; i < m; i++) {
    if (basis[i]! >= n && !isZero(table[i]![width]!)) {
      return undefined
    }
  }

  const x = Array.from({ length: n }, () => ZERO)

  for (let i = 0; i < m; i++) {
    if (basis[i]! < n) {
      x[basis[i]!] = table[i]![width]!
    }
  }

  return x
}

// search for a certificate that the facts are contradictory. Two shapes are tried: the combination is the constant
// -1, or it is 0 with the strict rows' multipliers summing to 1.
export function refute(facts: Fact[], focus?: number, linear?: LinearMode): Certificate | undefined {
  if (facts.length === 0 || facts.length > (linear ? 2000 : 14) || facts.some(f => degree(f.polynomial) > 4)) {
    return undefined
  }

  const rows = rowsOf(facts, focus, linear)
  const monomials = new Set<string>([''])

  for (const row of rows) {
    for (const key of row.polynomial.keys()) {
      monomials.add(key)
    }
  }

  const keys = [...monomials].sort()

  // a zero row's multiplier is free, so it is split into two non-negative columns, + and -
  const columns: { row: number; k: Rational }[] = []

  rows.forEach((row, i) => {
    columns.push({ row: i, k: ONE })

    if (row.relation === 'zero') {
      columns.push({ row: i, k: rational(-1n) })
    }
  })

  const matrix = keys.map(key =>
    columns.map(c => times(c.k, rows[c.row]!.polynomial.get(key) ?? ZERO)),
  )

  const attempts: { a: Rational[][]; b: Rational[] }[] = [
    // Σ = -1 identically
    { a: matrix, b: keys.map(key => (key === '' ? rational(-1n) : ZERO)) },
    // Σ = 0 identically, and the strict multipliers sum to 1
    {
      a: [
        ...matrix,
        columns.map(c => (rows[c.row]!.relation === 'positive' ? ONE : ZERO)),
      ],
      b: [...keys.map(() => ZERO), ONE],
    },
  ]

  for (const { a, b } of attempts) {
    const x = feasible(a, b)

    if (!x) {
      continue
    }

    const multipliers = rows.map(() => ZERO)

    columns.forEach((c, j) => {
      multipliers[c.row] = plus(multipliers[c.row]!, times(c.k, x[j]!))
    })

    const certificate: Certificate = { rows: rows.map(r => r.from), multipliers }

    if (replay(facts, certificate)) {
      return certificate
    }
  }

  return undefined
}

// does the goal follow from the facts? The goal is `polynomial >= 0` (or `> 0` when strict), so its negation is
// `-polynomial > 0` (or `-polynomial >= 0`), added as one more fact to refute.
export function productProves(facts: Fact[], goal: Polynomial, strict: boolean, linear?: LinearMode): boolean {
  const negation: Fact = {
    polynomial: scaled(goal, rational(-1n)),
    relation: strict ? 'nonnegative' : 'positive',
  }

  return refute([...facts, negation], facts.length, linear) !== undefined
}

// a number coefficient (from the integer-valued polynomial expansion in holds.ts) as an exact rational
export function fromNumbers(poly: Map<string, number>): Polynomial | undefined {
  const out: Polynomial = new Map()

  for (const [key, c] of poly) {
    if (!Number.isSafeInteger(c)) {
      return undefined
    }

    if (c !== 0) {
      out.set(key, rational(BigInt(c)))
    }
  }

  return out
}
