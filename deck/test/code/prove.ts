/**
 * Bounded exhaustive verification: instead of sampling random inputs
 * (which can miss a hole), enumerate EVERY input in a bounded domain
 * and decide the claim. Over the bound it is a proof, not a guess -
 * the "decide up to bound B" discipline from concepts.md.
 *
 * The enumeration is Term since 2026-10-04, deck/test/code/bounded-proof.tree.
 * This keeps the object-shaped signature and the default bound of 8 its
 * callers (gap, contract, ai-proposer, demo-loop) use.
 */

import { proveOver } from '@term/test/code/bounded-proof'
import type { ProveResult } from '@term/test/code/bounded-proof'

export type { ProveResult }

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
  return proveOver(input.arity, input.claim, input.bound ?? 8)
}
