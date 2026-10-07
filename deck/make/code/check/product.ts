// NONLINEAR ARITHMETIC BY PRODUCTS OF HYPOTHESES, the Positivstellensatz of degree two (Lean's `nlinarith`). The
// procedure is Term, check/products.tree (self-hosting, 2026-10-06), and its header says how it decides and why a wrong
// search can cost a proof and never forge one. This face converts the TypeScript shapes (bigint rationals, polynomials
// as maps, a certificate's row recipes) to and from the port's, and holds the two pieces of module state the port
// mutates: the work budget of the current goal, and the profile counters. `fromNumbers` reads a number map into
// rationals at the boundary.

import * as port from '@term/make/code/check/products'

// a polynomial: monomial key (variable names, sorted, joined by NUL as in holds.ts, '' for the constant) -> rational
export type Polynomial = Map<string, Rational>

export type Rational = { n: bigint; d: bigint }

export type Fact = { polynomial: Polynomial; relation: 'nonnegative' | 'positive' | 'zero' }

// how a certificate row was made: a fact (alone, times a monomial, or times a variable's square), a product of facts,
// or a square
type RowFrom = { fact: number; times?: string; square?: string } | { facts: number[] } | { square: string[] }

export type Certificate = { rows: RowFrom[]; multipliers: Rational[] }

// the LINEAR mode: the facts combined with non-negative multipliers and no products, except that an equation may be
// multiplied by each of `multipliers`
export type LinearMode = { multipliers: string[] }

const toBig = (value: bigint): port.BigInteger => ({ dock: value }) as port.BigInteger
const fromBig = (value: port.BigInteger): bigint => value.dock as bigint
const toRational = (r: Rational): port.Rational => ({ n: toBig(r.n), d: toBig(r.d) })
const fromRational = (r: port.Rational): Rational => ({ n: fromBig(r.n), d: fromBig(r.d) })
const toPolynomial = (p: Polynomial): Map<string, port.Rational> => new Map([...p].map(([key, r]) => [key, toRational(r)]))
const fromPolynomial = (p: Map<string, port.Rational>): Polynomial => new Map([...p].map(([key, r]) => [key, fromRational(r)]))
const toFact = (f: Fact): port.Fact => ({ polynomial: toPolynomial(f.polynomial), relation: f.relation })
const given = (text: string | undefined): port.Maybe<string> => (text === undefined ? { form: 'none' } : { form: 'some', value: text })

function toFrom(from: RowFrom): port.RowFrom {
  if ('fact' in from) {
    return { form: 'from-fact', fact: from.fact, times: given(from.times), square: given(from.square) }
  }

  if ('square' in from && Array.isArray(from.square)) {
    return { form: 'from-square', vars: from.square }
  }

  return { form: 'from-facts', facts: 'facts' in from ? from.facts : [] }
}

function fromFrom(from: port.RowFrom): RowFrom {
  if (from.form === 'from-fact') {
    return {
      fact: from.fact,
      ...(from.times.form === 'some' ? { times: from.times.value } : {}),
      ...(from.square.form === 'some' ? { square: from.square.value } : {}),
    }
  }

  return from.form === 'from-square' ? { square: from.vars } : { facts: from.facts }
}

export function rational(n: bigint, d = 1n): Rational {
  return fromRational(port.rationalOf(toBig(n), toBig(d)))
}

export function multiply(a: Polynomial, b: Polynomial): Polynomial {
  return fromPolynomial(port.multiplyPolynomials(toPolynomial(a), toPolynomial(b)))
}

// THE CHECKER: does the certificate's combination of the facts come out identically a negative constant, or zero with
// a strict row used
export function replay(facts: Fact[], certificate: Certificate): boolean {
  return port.replay(facts.map(toFact), { rows: certificate.rows.map(toFrom), multipliers: certificate.multipliers.map(toRational) })
}

// WHERE THE TIME GOES, counted for `TERM_PRODUCT_PROFILE=1`, read by holds.ts per goal. Counting changes nothing a
// search decides
export const productProfile = {
  refutes: 0,
  rows: 0,
  cells: 0,
  floatDeclined: 0,
  exactPivots: 0,
  // the cells an exact pivot rewrites, summed: the deterministic measure of the search's work (see THE BUDGET)
  exactWork: 0,
  buildMs: 0,
  exactMs: 0,
}

const profiling = typeof process !== 'undefined' && Boolean(process.env?.TERM_PRODUCT_PROFILE)

// THE BUDGET: the exact simplex's work for one goal, deterministic, so the same goal stops at the same place on every
// machine and every run. holds.ts opens one per goal and asks whether it ran out. Infinite until a caller opens one
const work = { budget: Infinity, spent: 0 }

export function openBudget(cells: number): void {
  work.budget = cells
  work.spent = 0
}

export function budgetSpent(): boolean {
  return work.spent >= work.budget
}

export function workSpent(): number {
  return work.spent
}

// work done OUTSIDE the exact simplex that the budget must still see: the case split's product refutations
// (check/universal.tree `by-cases`), each building products of its facts before any pivot. Counted only, never timed, so
// a goal still stops at the same place on every machine
export function spendWork(units: number): void {
  work.spent += units
}

const now = (): number => Date.now()
const linearOf = (linear: LinearMode | undefined): port.Maybe<string[]> =>
  linear ? { form: 'some', value: linear.multipliers } : { form: 'none' }

// search for a certificate that the facts are contradictory
export function refute(facts: Fact[], focus?: number, linear?: LinearMode): Certificate | undefined {
  const found = port.refute(facts.map(toFact), focus ?? -1, linearOf(linear), work, productProfile, profiling, now)

  return found.form === 'some'
    ? { rows: found.value.rows.map(fromFrom), multipliers: found.value.multipliers.map(fromRational) }
    : undefined
}

// does the goal follow from the facts? The goal is `polynomial >= 0` (or `> 0` when strict)
export function productProves(facts: Fact[], goal: Polynomial, strict: boolean, linear?: LinearMode): boolean {
  return port.productProves(facts.map(toFact), toPolynomial(goal), strict, linearOf(linear), work, productProfile, profiling, now)
}

// the same, on facts already in the port's shape, under this module's budget: check/induction.tree asks through it
export function portProves(facts: port.Fact[], goal: Map<string, port.Rational>, strict: boolean): boolean {
  return port.productProves(facts, goal, strict, { form: 'none' }, work, productProfile, profiling, now)
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
