import type { RecordNode, Value } from '@term/base/code/base/type'
import { canonicalizeRecord, canonicalizeValue } from '@term/base/code/canon/canonicalize'

// Structural equality by canonical form. Two values or records are equal when they
// mean the same thing, regardless of field order or set order.

export function valueEqual(a: Value, b: Value): boolean {
  return canonicalizeValue(a) === canonicalizeValue(b)
}

export function recordEqual(a: RecordNode, b: RecordNode): boolean {
  return canonicalizeRecord(a) === canonicalizeRecord(b)
}
