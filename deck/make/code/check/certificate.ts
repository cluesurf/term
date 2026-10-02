// CERTIFICATES for the linear prover. A refutation by Fourier-Motzkin with integer tightening is a cutting-plane
// proof: every row it derives is an input, a non-negative integer combination of two earlier rows, or a row divided
// by a common factor of its coefficients with the bound rounded down. So a refutation can be written down as that
// derivation, and checked by replaying it.
//
// The SEARCH lives in refine.ts and is large: elimination order, memoization, deduplication. The CHECKER below is
// small and shares nothing with it but the shape of a constraint. A bug in the search can now cost a proof (the
// derivation does not replay, so the goal is not proven) and can never forge one. proof-by-default-0022.
//
// Constraints are `Σ c·x + k <= 0` over the integers. A strict `< 0` is tightened to `+ 1 <= 0` before anything else,
// which is exact over the integers.

import type { Linear } from '@term/make/code/check/refine'

type Row = { terms: Map<string, number>; constant: number }

// how a row was obtained
export type Step =
  // an input constraint, by position, already tightened (a strict input contributes its `+ 1`)
  | { by: 'input'; at: number }
  // a·first + b·second, with a, b positive integers
  | { by: 'sum'; first: Step; second: Step; a: number; b: number }
  // the row divided by g, a positive integer dividing every coefficient, with the bound rounded down (a Chvátal-Gomory
  // cut, exact because the variables are integers)
  | { by: 'cut'; of: Step; g: number }

// the input constraints, tightened to non-strict integer rows
export function tighten(
  inputs: { linear: Linear; strict: boolean }[],
): Row[] {
  return inputs.map(i => ({
    terms: new Map(
      [...i.linear.terms].filter(([, c]) => Math.round(c) !== 0).map(([v, c]) => [v, Math.round(c)]),
    ),
    constant: Math.round(i.linear.constant) + (i.strict ? 1 : 0),
  }))
}

// replay a derivation over the inputs, or undefined when any step is not a valid inference
function replay(step: Step, inputs: Row[], depth = 0): Row | undefined {
  if (depth > 10_000) {
    return undefined
  }

  switch (step.by) {
    case 'input': {
      const row = inputs[step.at]

      return row
        ? { terms: new Map(row.terms), constant: row.constant }
        : undefined
    }

    case 'sum': {
      if (
        !Number.isInteger(step.a) ||
        !Number.isInteger(step.b) ||
        step.a <= 0 ||
        step.b <= 0
      ) {
        return undefined
      }

      const first = replay(step.first, inputs, depth + 1)
      const second = replay(step.second, inputs, depth + 1)

      if (!first || !second) {
        return undefined
      }

      const terms = new Map<string, number>()

      for (const [v, c] of first.terms) {
        terms.set(v, (terms.get(v) ?? 0) + step.a * c)
      }

      for (const [v, c] of second.terms) {
        terms.set(v, (terms.get(v) ?? 0) + step.b * c)
      }

      for (const [v, c] of [...terms]) {
        if (c === 0) {
          terms.delete(v)
        }
      }

      return {
        terms,
        constant: step.a * first.constant + step.b * second.constant,
      }
    }

    case 'cut': {
      const row = replay(step.of, inputs, depth + 1)

      if (!row || !Number.isInteger(step.g) || step.g <= 0) {
        return undefined
      }

      const terms = new Map<string, number>()

      for (const [v, c] of row.terms) {
        if (c % step.g !== 0) {
          return undefined
        }

        terms.set(v, c / step.g)
      }

      // Σ c·x <= -k becomes Σ (c/g)·x <= floor(-k / g), so the new constant is -floor(-k / g)
      return { terms, constant: -Math.floor(-row.constant / step.g) }
    }

    default:
      return undefined
  }
}

// is this derivation a refutation of these inputs: does it replay, and end at `k <= 0` with no variable and k > 0
export function checkRefutation(
  inputs: { linear: Linear; strict: boolean }[],
  step: Step,
): boolean {
  const row = replay(step, tighten(inputs))

  return row !== undefined && row.terms.size === 0 && row.constant > 0
}

// ---- the search side: Fourier-Motzkin with integer tightening, recording how every row was made ----

type Tracked = { row: Row; step: Step }

function key(row: Row): string {
  return (
    [...row.terms].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([v, c]) => `${v}:${c}`).join(',') +
    `|${row.constant}`
  )
}

function gcd(a: number, b: number): number {
  a = Math.abs(a)
  b = Math.abs(b)

  while (b) {
    ;[a, b] = [b, a % b]
  }

  return a
}

// divide a row by the gcd of its coefficients, rounding the bound down (a cut), when that gcd is above one
function normalize(t: Tracked): Tracked {
  let g = 0

  for (const c of t.row.terms.values()) {
    g = gcd(g, c)
  }

  if (g <= 1) {
    return t
  }

  const terms = new Map<string, number>()

  for (const [v, c] of t.row.terms) {
    terms.set(v, c / g)
  }

  return {
    row: { terms, constant: -Math.floor(-t.row.constant / g) },
    step: { by: 'cut', of: t.step, g },
  }
}

const MAX_ROWS = 4_000

// find a refutation of the inputs and return its derivation, or undefined when none is found within the row bound.
// Undefined never means "satisfiable": the caller has already decided that with refine.ts, and only asks for the
// derivation of a refutation it found.
export function refutation(
  inputs: { linear: Linear; strict: boolean }[],
): Step | undefined {
  let rows: Tracked[] = tighten(inputs).map((row, at) =>
    normalize({ row, step: { by: 'input', at } }),
  )

  const contradiction = (t: Tracked): boolean =>
    t.row.terms.size === 0 && t.row.constant > 0

  for (;;) {
    const found = rows.find(contradiction)

    if (found) {
      return found.step
    }

    // drop tautologies (no variables, constant <= 0) and duplicates
    const seen = new Map<string, Tracked>()

    for (const t of rows) {
      if (t.row.terms.size === 0) {
        continue
      }

      const k = key(t.row)

      if (!seen.has(k)) {
        seen.set(k, t)
      }
    }

    rows = [...seen.values()]

    const variables = new Set<string>()

    for (const t of rows) {
      for (const v of t.row.terms.keys()) {
        variables.add(v)
      }
    }

    if (variables.size === 0 || rows.length > MAX_ROWS) {
      return undefined
    }

    // the same order the search prefers: a unit variable first (exact over the integers), then the cheapest
    let best: string | undefined
    let bestKey: [number, number] = [Infinity, Infinity]

    for (const v of variables) {
      let pos = 0
      let neg = 0
      let unit = true

      for (const t of rows) {
        const c = t.row.terms.get(v) ?? 0

        if (c > 0) {
          pos++
        } else if (c < 0) {
          neg++
        }

        if (c !== 0 && Math.abs(c) !== 1) {
          unit = false
        }
      }

      const candidate: [number, number] = [unit ? 0 : 1, pos * neg]

      if (
        candidate[0] < bestKey[0] ||
        (candidate[0] === bestKey[0] && candidate[1] < bestKey[1])
      ) {
        bestKey = candidate
        best = v
      }
    }

    const v = best!
    const positive = rows.filter(t => (t.row.terms.get(v) ?? 0) > 0)
    const negative = rows.filter(t => (t.row.terms.get(v) ?? 0) < 0)
    const next: Tracked[] = rows.filter(t => (t.row.terms.get(v) ?? 0) === 0)

    for (const p of positive) {
      const cp = p.row.terms.get(v)!

      for (const n of negative) {
        const cn = n.row.terms.get(v)!
        // (-cn)·p + cp·n cancels v, both multipliers positive
        const a = -cn
        const b = cp
        const terms = new Map<string, number>()

        for (const [w, c] of p.row.terms) {
          terms.set(w, (terms.get(w) ?? 0) + a * c)
        }

        for (const [w, c] of n.row.terms) {
          terms.set(w, (terms.get(w) ?? 0) + b * c)
        }

        for (const [w, c] of [...terms]) {
          if (c === 0) {
            terms.delete(w)
          }
        }

        next.push(
          normalize({
            row: { terms, constant: a * p.row.constant + b * n.row.constant },
            step: { by: 'sum', first: p.step, second: n.step, a, b },
          }),
        )
      }
    }

    rows = next
  }
}

// ===== GRAM CERTIFICATES for the polynomial provers =====
//
// `p >= 0` holds everywhere when p = zᵀ Q z for a vector of monomials z and a positive SEMIDEFINITE matrix Q: then p is
// a sum of squares. `p > 0` holds everywhere when Q is positive DEFINITE and z contains the constant monomial 1, since
// z is then never the zero vector. The searches in holds.ts (the quadratic test, the Gram search, the diagonal sum of
// squares) each find such a Q. This checker is told z and M = 2Q and the polynomial 2p, and decides both facts again
// with its own arithmetic: its own monomial product, its own BigInt expansion, and positive-semidefiniteness by exact
// fraction-free symmetric elimination, which is a different algorithm from the searches' principal minors. A search
// that finds a wrong Q costs a proof here and cannot forge one. proof-by-default-0034.

export type Gram = {
  // each monomial of z, as the list of its variables with repetition (x² is ['x', 'x'], the constant is [])
  basis: string[][]
  // M = 2Q, symmetric, integer
  matrix: number[][]
  // 2p, keyed by monomial as the checker keys it (`gramKey`)
  target: Map<string, number>
  // p > 0 rather than p >= 0
  strict: boolean
}

// the checker's own key for a monomial: its variables sorted and joined
export function gramKey(variables: string[]): string {
  return [...variables].sort().join('*')
}

export function checkGram(certificate: Gram): boolean {
  const { basis, matrix, target, strict } = certificate
  const n = basis.length

  if (
    matrix.length !== n ||
    matrix.some(row => row.length !== n || row.some(v => !Number.isSafeInteger(v)))
  ) {
    return false
  }

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (matrix[i]![j] !== matrix[j]![i]) {
        return false
      }
    }
  }

  // zᵀ M z, every ordered pair, in BigInt
  const expanded = new Map<string, bigint>()

  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const key = gramKey([...basis[i]!, ...basis[j]!])
      expanded.set(key, (expanded.get(key) ?? 0n) + BigInt(matrix[i]![j]!))
    }
  }

  for (const key of new Set([...expanded.keys(), ...target.keys()])) {
    const want = target.get(key) ?? 0

    if (!Number.isSafeInteger(want) || (expanded.get(key) ?? 0n) !== BigInt(want)) {
      return false
    }
  }

  if (strict && !basis.some(m => m.length === 0)) {
    return false
  }

  return strict ? definite(matrix) : semidefinite(matrix)
}

// positive semidefinite, by symmetric elimination without division: a negative pivot refutes it, a zero pivot needs
// its whole row to be zero, and a positive pivot p replaces the rest by p·A[i][j] - A[i][k]·A[k][j], which is p times
// the Schur complement and so is semidefinite exactly when the complement is
function semidefinite(matrix: number[][]): boolean {
  const a = matrix.map(row => row.map(v => BigInt(v)))
  const n = a.length

  for (let k = 0; k < n; k++) {
    const pivot = a[k]![k]!

    if (pivot < 0n) {
      return false
    }

    if (pivot === 0n) {
      for (let j = k + 1; j < n; j++) {
        if (a[k]![j] !== 0n) {
          return false
        }
      }

      continue
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        a[i]![j] = pivot * a[i]![j]! - a[i]![k]! * a[k]![j]!
      }
    }
  }

  return true
}

// positive definite: the same elimination, with every pivot strictly positive
function definite(matrix: number[][]): boolean {
  const a = matrix.map(row => row.map(v => BigInt(v)))
  const n = a.length

  for (let k = 0; k < n; k++) {
    const pivot = a[k]![k]!

    if (pivot <= 0n) {
      return false
    }

    for (let i = k + 1; i < n; i++) {
      for (let j = k + 1; j < n; j++) {
        a[i]![j] = pivot * a[i]![j]! - a[i]![k]! * a[k]![j]!
      }
    }
  }

  return true
}
