import type { Value } from '@term/base/code/base/type'
import {
  canonicalizeValue,
  parseDecimal,
} from '@term/base/code/canon/canonicalize'

// Compare two decimal strings EXACTLY, by aligning their base-10 exponents and
// comparing bigint mantissas. `Number()` would collapse a high-precision or
// large-magnitude decimal to a double, so two 20-digit decimals differing in the
// last digit compared equal and a range query silently dropped one.
function compareDecimal(a: string, b: string): number {
  const pa = parseDecimal(a)
  const pb = parseDecimal(b)
  const shared = Math.min(pa.exponent, pb.exponent)
  const ma = pa.mantissa * 10n ** BigInt(pa.exponent - shared)
  const mb = pb.mantissa * 10n ** BigInt(pb.exponent - shared)
  return ma < mb ? -1 : ma > mb ? 1 : 0
}

// Ordering for query comparisons and ordered indexes. Same-kind scalars order
// naturally (numbers numerically, text and dates lexically); anything else falls back
// to canonical form, which is deterministic though not semantically meaningful across
// kinds. Kept in one place so the query evaluator and the ordered index never disagree.

export function compareValues(a: Value, b: Value): number {
  if (a.kind === 'integer' && b.kind === 'integer') {
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0
  }
  if (a.kind === 'decimal' && b.kind === 'decimal') {
    return compareDecimal(a.value, b.value)
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
