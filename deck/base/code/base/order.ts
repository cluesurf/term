// Fractional order keys for collaborative sibling ordering. Semantic parent identity,
// relative sibling position, and display index are three different things, and the
// display index must never be the durable identity of a position. A fractional key is a
// string that sorts lexicographically, and a new key can always be generated strictly
// between two existing ones, so two people inserting at the same place get distinct,
// stably-ordered keys without renumbering their neighbours.
//
// See note/library/base/design/collaboration-correctness.md.

const BASE = '0123456789abcdefghijklmnopqrstuvwxyz'

function digit(s: string, i: number, fallback: number): number {
  if (i >= s.length) {
    return fallback
  }
  const d = BASE.indexOf(s[i]!)
  return d === -1 ? fallback : d
}

// A key strictly between `lo` and `hi` (each optional: empty `lo` is the start, empty
// `hi` is the end). The result sorts after `lo` and before `hi`.
export function orderKeyBetween(lo = '', hi = ''): string {
  let i = 0
  let out = ''
  for (;;) {
    const a = digit(lo, i, 0)
    const b = digit(hi, i, BASE.length)
    if (a === b) {
      out += BASE[a]
      i++
      continue
    }
    const mid = Math.floor((a + b) / 2)
    if (mid > a) {
      return out + BASE[mid]
    }
    // no room at this position: copy lo's digit and descend
    out += BASE[a]
    i++
  }
}

// A key that sorts after everything given (append).
export function orderKeyAfter(last?: string): string {
  return orderKeyBetween(last ?? '', '')
}

// A key that sorts before everything given (prepend).
export function orderKeyBefore(first?: string): string {
  return orderKeyBetween('', first ?? '')
}
