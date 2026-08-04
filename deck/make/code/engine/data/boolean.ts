// The boolean type. A trit gives a natural THREE-valued logic for free: -1 false, 0 unknown, +1 true (balanced
// Kleene / strong three-valued logic). The "unknown" is the don't-care of associative search and the empty cell.
// Ordinary two-valued boolean is the {-1, +1} subset. One trit, one cell, so a 24-cell dock holds 24 booleans.

import type { Trit } from '@term/make/code/engine/data/trit'

export type Bool3 = Trit // -1 false, 0 unknown, +1 true

export const FALSE: Bool3 = -1
export const UNKNOWN: Bool3 = 0
export const TRUE: Bool3 = 1

export function fromBoolean(value: boolean): Bool3 {
  return value ? TRUE : FALSE
}

// to a definite boolean (unknown counts as false, the conservative read)
export function toBoolean(value: Bool3): boolean {
  return value === TRUE
}

// strong Kleene three-valued connectives: and is min, or is max, not is negation
export function not(a: Bool3): Bool3 {
  return -a as Bool3
}

export function and(a: Bool3, b: Bool3): Bool3 {
  return Math.min(a, b) as Bool3
}

export function or(a: Bool3, b: Bool3): Bool3 {
  return Math.max(a, b) as Bool3
}

// material implication a -> b = (not a) or b, in three-valued logic
export function implies(a: Bool3, b: Bool3): Bool3 {
  return or(not(a), b)
}

// exclusive or, true when exactly one side is true and neither is unknown, unknown if either is unknown
export function xor(a: Bool3, b: Bool3): Bool3 {
  if (a === UNKNOWN || b === UNKNOWN) {
    return UNKNOWN
  }

  return a === b ? FALSE : TRUE
}

// is the value definite (not unknown)
export function isDefinite(a: Bool3): boolean {
  return a !== UNKNOWN
}

export function toString(a: Bool3): string {
  return a === TRUE ? 'true' : a === FALSE ? 'false' : 'unknown'
}
