import type { Value } from '@term/base/code/base/type'
import { canonicalizeValue } from '@term/base/code/canon/canonicalize'

// Ordering for query comparisons and ordered indexes. Same-kind scalars order
// naturally (numbers numerically, text and dates lexically); anything else falls back
// to canonical form, which is deterministic though not semantically meaningful across
// kinds. Kept in one place so the query evaluator and the ordered index never disagree.

export function compareValues(a: Value, b: Value): number {
  if (a.kind === 'integer' && b.kind === 'integer') {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  }
  if (a.kind === 'decimal' && b.kind === 'decimal') {
    const x = Number(a.value)
    const y = Number(b.value)
    return x < y ? -1 : x > y ? 1 : 0
  }
  if (a.kind === 'text' && b.kind === 'text') {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  }
  if (a.kind === 'date' && b.kind === 'date') {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  }
  const ca = canonicalizeValue(a)
  const cb = canonicalizeValue(b)
  return ca < cb ? -1 : ca > cb ? 1 : 0
}

// The text of a value for prefix matching, or undefined if it has none.
export function fieldText(value: Value): string | undefined {
  if (value.kind === 'text') {
    return value.value
  }
  if (value.kind === 'date') {
    return value.value
  }
  return undefined
}
