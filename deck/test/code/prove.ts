/**
 * Bounded exhaustive verification: instead of sampling random inputs
 * (which can miss a hole), enumerate EVERY input in a bounded domain
 * and decide the claim. Over the bound it is a proof, not a guess -
 * the "decide up to bound B" discipline from concepts.md (the same
 * idea as bounded model checking, without an SMT backend yet).
 *
 * Use `prove` when the input space is small integers (guards,
 * comparisons, arithmetic over a few variables): it returns a real
 * "holds for all |x| <= B" or the exact counterexample. Fall back to
 * sampling (./property) when the space is too large to enumerate.
 *
 * This is what lets the synthesizer (./synthesize) verify a candidate
 * by PROOF over the bound, so a synthesized program is correct on the
 * whole bounded domain, not merely on the samples it happened to see.
 */

export type ProveResult =
  | { ok: true; checked: number }
  | { ok: false; counterexample: number[]; checked: number }

/**
 * Decide `claim` over every integer tuple of length `arity` with each
 * component in [-bound, bound]. Returns the first counterexample, or a
 * proof (over the bound) that none exists.
 */
export function prove(input: {
  arity: number
  claim: (inputs: number[]) => boolean
  bound?: number
}): ProveResult {
  const { arity, claim } = input
  const bound = input.bound ?? 8

  const point = new Array<number>(arity).fill(-bound)
  let checked = 0

  for (;;) {
    checked++

    if (!safe(claim, point)) {
      return { ok: false, counterexample: point.slice(), checked }
    }

    if (!increment(point, -bound, bound)) {
      return { ok: true, checked }
    }
  }
}

/** A claim that throws counts as failing, not crashing. */
function safe(claim: (inputs: number[]) => boolean, point: number[]): boolean {
  try {
    return claim(point)
  } catch {
    return false
  }
}

/**
 * Odometer-increment the point through [lo, hi]^n. Returns false when
 * it has wrapped past the last tuple (enumeration complete).
 */
function increment(point: number[], lo: number, hi: number): boolean {
  for (let i = point.length - 1; i >= 0; i--) {
    if (point[i] < hi) {
      point[i]++
      return true
    }
    point[i] = lo
  }
  return false
}
