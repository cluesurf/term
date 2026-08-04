import { randomUUID } from 'node:crypto'
import type { Mark } from '@/base/type'

// A mark is a time-independent random UUID (version 4). It carries no timestamp,
// so a record's identity reveals nothing about when it was made and is not coupled
// to time. Time and ordering live in the commit graph, not the mark. Random keys
// also suit the substrate: a prolly tree is order-independent, and a distributed
// database prefers random keys to spread writes.
//
// See note/library/base/design/identity-lifecycle.md.

const UUID_V4 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

// Mint a fresh mark. Generated client-side, so live and concurrent creation never
// collide (122 bits of randomness make a collision negligible).
export function mintMark(): Mark {
  return randomUUID()
}

// A mark is well-formed if it is a canonical lowercase UUID version 4.
export function isMark(value: string): boolean {
  return UUID_V4.test(value)
}

// Normalize a mark to its canonical lowercase form, or throw if malformed.
export function normalizeMark(value: string): Mark {
  const lower = value.toLowerCase()
  if (!isMark(lower)) {
    throw new Error(`invalid mark: ${value}`)
  }
  return lower
}
