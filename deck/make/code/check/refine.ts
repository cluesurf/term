// Refinement-type verification: the linear prover. The search is Term, check/eliminate.tree (self-hosting,
// 2026-10-06), and its header says how it decides. This face keeps the module state Term cannot hold: the
// satisfiability memo, and the count of answers whose certificate did not replay.

import {
  above,
  atLeast,
  atMost,
  below,
  certified,
  decide,
  reduceSystem,
  refutable,
  systemKey,
  tightenStrict,
} from '@term/make/code/check/eliminate'
import type { Inequality } from '@term/make/code/check/certificate'

export { above, atLeast, atMost, below }

// a linear expression: sum of coefficient * variable, plus a constant
export type Linear = { terms: Map<string, number>; constant: number }

export function linear(
  terms: Record<string, number>,
  constant = 0,
): Linear {
  return { terms: new Map(Object.entries(terms)), constant }
}

// satisfiability memo: the same canonical constraint system recurs often across a compile (many holds share the same
// shape, e.g. `n >= 0 |- n*n >= 0`), so caching the verdict by the system's canonical key avoids re-running the whole
// elimination. Keyed on the REDUCED system, so two systems that normalize to the same constraints share a result.
const satCache = new Map<string, boolean>()

// is the system of constraints unsatisfiable?
function unsatisfiable(ineqs: Inequality[]): boolean {
  const reduced = reduceSystem(tightenStrict(ineqs))

  // a contradiction was already manifest
  if (reduced.form === 'none') {
    return true
  }

  const cacheKey = systemKey(reduced.value)
  const cached = satCache.get(cacheKey)

  if (cached !== undefined) {
    return cached
  }

  const verdict = decide(reduced.value)
  satCache.set(cacheKey, verdict)

  return verdict
}

// how often the search said "proven" and its refutation then failed to replay through the certificate checker. Each
// is a goal reported unproven rather than trusted, and a nonzero count is a bug in the search worth chasing.
let uncertified = 0

export function uncertifiedCount(): number {
  return uncertified
}

// a polynomial prover's answer that its Gram certificate did not confirm (holds.ts certified), counted the same way
export function noteUncertified(): void {
  uncertified++
}

// does the conjunction of assumptions imply the goal? Valid iff assumptions AND not(goal) is unsatisfiable, and only a
// refutation that replays through the certificate checker counts. proof-by-default-0022.
export function proves(
  assumptions: Inequality[],
  goal: Inequality,
): boolean {
  const system = refutable(assumptions, goal)

  if (!unsatisfiable(system)) {
    return false
  }

  if (certified(system)) {
    return true
  }

  uncertified++

  return false
}
