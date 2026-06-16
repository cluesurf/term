// The string type, a ROPE: a balanced tree of text chunks, not a flat buffer. Concatenation, index, and slice are
// O(log n), and the tree is the shape the hyperbolic substrate wants (a subtree of the splitting tree). Each
// codepoint has a balanced-ternary view (its Unicode scalar as a ternary integer), so text and numbers share the
// one alphabet.

import { toTrits, type Trit } from '@/code/engine/data/trit'

export type Rope =
  | { form: 'leaf'; text: string; length: number }
  | { form: 'branch'; left: Rope; right: Rope; length: number; depth: number }

const MAX_LEAF = 64 // codepoints per leaf chunk
const REBALANCE_DEPTH = 32 // rebuild when the tree gets this deep relative to its size

export function fromString(text: string): Rope {
  const points = Array.from(text) // split on codepoints, not UTF-16 units
  return build(points)
}

function build(points: string[]): Rope {
  if (points.length <= MAX_LEAF) return { form: 'leaf', text: points.join(''), length: points.length }
  const mid = points.length >> 1
  return branch(build(points.slice(0, mid)), build(points.slice(mid)))
}

function depthOf(r: Rope): number { return r.form === 'leaf' ? 0 : r.depth }

function branch(left: Rope, right: Rope): Rope {
  return { form: 'branch', left, right, length: left.length + right.length, depth: 1 + Math.max(depthOf(left), depthOf(right)) }
}

export function length(r: Rope): number { return r.length }

export function concat(a: Rope, b: Rope): Rope {
  if (a.length === 0) return b
  if (b.length === 0) return a
  const joined = branch(a, b)
  return depthOf(joined) > REBALANCE_DEPTH ? fromString(toString(joined)) : joined
}

// the codepoint (as a string) at an index, O(log n)
export function charAt(r: Rope, index: number): string {
  if (index < 0 || index >= r.length) throw new Error(`index ${index} out of range (length ${r.length})`)
  let node = r
  let i = index
  while (node.form === 'branch') {
    if (i < node.left.length) node = node.left
    else { i -= node.left.length; node = node.right }
  }
  return Array.from(node.text)[i]!
}

// the Unicode scalar at an index, as a number
export function codePointAt(r: Rope, index: number): number {
  return charAt(r, index).codePointAt(0)!
}

// the balanced-ternary digits of the codepoint at an index (text in the one ternary alphabet)
export function tritsAt(r: Rope, index: number): Trit[] {
  return toTrits(BigInt(codePointAt(r, index)))
}

export function slice(r: Rope, start: number, end: number = r.length): Rope {
  const s = Math.max(0, start)
  const e = Math.min(r.length, end)
  if (s >= e) return { form: 'leaf', text: '', length: 0 }
  if (r.form === 'leaf') {
    const points = Array.from(r.text).slice(s, e)
    return { form: 'leaf', text: points.join(''), length: points.length }
  }
  const leftLen = r.left.length
  if (e <= leftLen) return slice(r.left, s, e)
  if (s >= leftLen) return slice(r.right, s - leftLen, e - leftLen)
  return concat(slice(r.left, s, leftLen), slice(r.right, 0, e - leftLen))
}

export function toString(r: Rope): string {
  if (r.form === 'leaf') return r.text
  return toString(r.left) + toString(r.right)
}

export function equals(a: Rope, b: Rope): boolean {
  return a.length === b.length && toString(a) === toString(b)
}
