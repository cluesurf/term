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
export function linear(
  terms: Record<string, number>,
  constant = 0,
): Linear {
  return { terms: new Map(Object.entries(terms)), constant }
}

function scale(a: Linear, k: number): Linear {
  const terms = new Map<string, number>()

  for (const [v, c] of a.terms) {
    terms.set(v, c * k)
  }

  return { terms, constant: a.constant * k }
}

function plus(a: Linear, b: Linear): Linear {
  const terms = new Map(a.terms)

  for (const [v, c] of b.terms) {
    terms.set(v, (terms.get(v) ?? 0) + c)
  }

  return { terms, constant: a.constant + b.constant }
}

// ---- public comparison builders (each returns an Inequality in `<= 0` / `< 0` form) ----
// a <= b   ->   a - b <= 0
export const atMost = (a: Linear, b: Linear): Inequality => ({
  linear: plus(a, scale(b, -1)),
  strict: false,
})
// a < b    ->   a - b < 0
export const below = (a: Linear, b: Linear): Inequality => ({
  linear: plus(a, scale(b, -1)),
  strict: true,
})
// a >= b   ->   b - a <= 0
export const atLeast = (a: Linear, b: Linear): Inequality =>
  atMost(b, a)
// a > b    ->   b - a < 0
export const above = (a: Linear, b: Linear): Inequality => below(b, a)

// negate a constraint (for refutation): not(l <= 0) is l > 0 i.e. -l < 0; not(l < 0) is l >= 0 i.e. -l <= 0
function negate(ineq: Inequality): Inequality {
  return { linear: scale(ineq.linear, -1), strict: !ineq.strict }
}

function variables(ineqs: Inequality[]): string[] {
  const set = new Set<string>()

  for (const ineq of ineqs) {
    for (const v of ineq.linear.terms.keys()) {
      if (Math.abs(ineq.linear.terms.get(v)!) > 1e-12) {
        set.add(v)
      }
    }
  }

  return [...set]
}

function coeff(ineq: Inequality, v: string): number {
  return ineq.linear.terms.get(v) ?? 0
}

const wholeGcd = (a: number, b: number): number => {
  a = Math.abs(Math.round(a))
  b = Math.abs(Math.round(b))

  while (b) {
    ;[a, b] = [b, a % b]
  }

  return a
}

// canonicalize a constraint for deduplication: drop ~zero terms, and gcd-reduce the integer coefficients together with
// the constant when their common divisor divides all of them (dividing `l <= 0` by a positive g is an equivalent
// constraint, so this is sound and never weakens the system). Returns the normalized constraint plus a string key,
// or the verdict `'true'` (a tautology to drop) / `'false'` (a contradiction). Constraints are integer-valued here
// because Fourier-Motzkin combines them with integer multipliers, so rounding is exact.
type Norm =
  | { kind: 'ineq'; ineq: Inequality; key: string }
  | { kind: 'true' }
  | { kind: 'false' }

function normalize(ineq: Inequality): Norm {
  const terms = new Map<string, number>()

  for (const [v, c] of ineq.linear.terms) {
    const r = Math.round(c)

    if (r !== 0) {
      terms.set(v, r)
    }
  }

  let k = Math.round(ineq.linear.constant)

  if (terms.size === 0) {
    // a pure constant constraint: `k <= 0` (or `k < 0` if strict) is decidable immediately
    const holds = ineq.strict ? k < 0 : k <= 0

    return holds ? { kind: 'true' } : { kind: 'false' }
  }

  let g = 0

  for (const c of terms.values()) {
    g = wholeGcd(g, c)
  }

  g = wholeGcd(g, k)

  if (g > 1) {
    for (const [v, c] of terms) {
      terms.set(v, c / g)
    }

    k = k / g
  }

  const sorted = [...terms].sort((a, b) => (a[0] < b[0] ? -1 : 1))
  const key =
    sorted.map(([v, c]) => `${v}:${c}`).join(',') +
    `|${k}|${ineq.strict ? '<' : '<='}`

  return {
    kind: 'ineq',
    ineq: { linear: { terms, constant: k }, strict: ineq.strict },
    key,
  }
}

// normalize, dedup, and detect a contradiction in a constraint set. Returns the canonical constraints, or null if the
// set is already unsatisfiable (a pure-constant `false`). Tautologies are dropped. This curbs the Fourier-Motzkin
// blowup: each elimination step otherwise multiplies the row count, and duplicate / subsumed rows pile up fast.
function reduce(ineqs: Inequality[]): Inequality[] | null {
  const seen = new Map<string, Inequality>()

  for (const ineq of ineqs) {
    const norm = normalize(ineq)

    if (norm.kind === 'false') {
      return null
    }

    if (norm.kind === 'true') {
      continue
    }

    seen.set(norm.key, norm.ineq)
  }

  return [...seen.values()]
}

// eliminate one variable by Fourier-Motzkin: combine each positive-coefficient row with each negative one. The result
// is reduced (normalized + deduped) by the caller.
function eliminate(ineqs: Inequality[], v: string): Inequality[] {
  const positive: Inequality[] = []
  const negative: Inequality[] = []
  const free: Inequality[] = []

  for (const ineq of ineqs) {
    const c = coeff(ineq, v)

    if (c > 1e-12) {
      positive.push(ineq)
    } else if (c < -1e-12) {
      negative.push(ineq)
    } else {
      free.push(ineq)
    }
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

// a canonical key for a reduced (already-normalized) constraint, for the satisfiability memo below
function canonKey(ineq: Inequality): string {
  const sorted = [...ineq.linear.terms]
    .filter(([, c]) => Math.abs(c) > 1e-9)
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))

  return (
    sorted.map(([v, c]) => `${v}:${Math.round(c)}`).join(',') +
    `|${Math.round(ineq.linear.constant)}|${ineq.strict ? '<' : '<='}`
  )
}

// satisfiability memo: the same canonical constraint system recurs often across a compile (many holds share the same
// shape, e.g. `n >= 0 |- n*n >= 0`), so caching the verdict by the system's canonical key avoids re-running the whole
// elimination. Keyed on the REDUCED system, so two systems that normalize to the same constraints share a result.
const satCache = new Map<string, boolean>()

// is the system of constraints unsatisfiable?
function unsatisfiable(ineqs: Inequality[]): boolean {
  // integer tightening: the program variables are integers, so a strict `l < 0` is exactly `l + 1 <= 0`. Tightening
  // up front makes the procedure integer-sound (it now proves e.g. n > 0 => n >= 1, which is false over rationals).
  const tightened = ineqs.map(ineq =>
    ineq.strict
      ? {
          linear: {
            terms: ineq.linear.terms,
            constant: ineq.linear.constant + 1,
          },
          strict: false,
        }
      : ineq,
  )

  let system = reduce(tightened)

  if (system === null) {
    return true
  } // a contradiction was already manifest

  // memo lookup on the reduced (canonical) system
  const cacheKey = system.map(canonKey).sort().join(';')
  const cached = satCache.get(cacheKey)

  if (cached !== undefined) {
    return cached
  }

  const remember = (verdict: boolean): boolean => {
    satCache.set(cacheKey, verdict)

    return verdict
  }

  // eliminate one variable per round, always the cheapest, until none remain (every constraint is pure-constant).
  // Each round removes exactly one variable, so this terminates in (number of variables) rounds.
  for (let vars = variables(system); vars.length > 0; ) {
    // smart elimination order: pick the variable whose elimination creates the FEWEST new rows (its positive-count
    // times negative-count), so the constraint set grows as slowly as possible. This is the standard heuristic that
    // keeps Fourier-Motzkin tractable.
    let best = vars[0]!
    let bestCost = Infinity

    for (const v of vars) {
      let pos = 0
      let neg = 0

      for (const ineq of system) {
        const c = coeff(ineq, v)

        if (c > 1e-12) {
          pos++
        } else if (c < -1e-12) {
          neg++
        }
      }

      const cost = pos * neg

      if (cost < bestCost) {
        bestCost = cost
        best = v
      }
    }

    const next = reduce(eliminate(system, best))

    if (next === null) {
      return remember(true)
    } // elimination exposed a contradiction

    system = next
    vars = variables(system)
  }

  // every remaining constraint is pure-constant; a positive constant is a contradiction
  for (const ineq of system) {
    if (ineq.linear.constant > 1e-9) {
      return remember(true)
    }
  }

  return remember(false)
}

// does the conjunction of assumptions imply the goal? (the verification condition is valid)
export function proves(
  assumptions: Inequality[],
  goal: Inequality,
): boolean {
  // valid iff assumptions AND not(goal) is unsatisfiable
  return unsatisfiable([...assumptions, negate(goal)])
}
