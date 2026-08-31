// One canonical serialization of a `Program`, so two paths that claim to build the same AST can be held to it
// byte for byte (mint-bridge-0001). The hand-written `compile/mill.ts` and the grammar-driven executor both
// produce a `Program`; `pnpm term:mint-parity` renders each through here and diffs the text.
//
// Canonical means: keys in sorted order, a key whose value is `undefined` dropped (so an absent field and a
// field explicitly set to undefined read the same), and every value rendered in a form that round trips. Spans
// are INCLUDED and are not negotiable: an AST node that cannot say where it came from cannot report an error,
// which is the whole reason the executor threads the CST node through minting.
//
// `diffCanonical` reports the first differences by path rather than a wall of text, so a failing file names the
// node and field that disagree instead of asking someone to eyeball two thousand lines of JSON.

import type { Program, Statement } from '@term/make/code/compile/node'

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

// A bigint (an integer literal wider than a JS number) renders tagged rather than lossily coerced: `2n ** 63n`
// through `Number()` is a different value, and this file exists to catch exactly that class of difference.
const BIGINT_TAG = '$bigint'

export function canonical(value: unknown): CanonicalValue {
  if (value === null || value === undefined) {
    return null
  }

  if (typeof value === 'bigint') {
    return { [BIGINT_TAG]: value.toString() }
  }

  if (
    typeof value === 'boolean' ||
    typeof value === 'string'
  ) {
    return value
  }

  if (typeof value === 'number') {
    // -0 and 0 are the same value to a reader and different to Object.is; normalize so a sign that no backend
    // can observe never shows up as a parity difference
    return Object.is(value, -0) ? 0 : value
  }

  if (Array.isArray(value)) {
    return value.map(canonical)
  }

  if (typeof value === 'object') {
    const out: { [key: string]: CanonicalValue } = {}

    for (const key of Object.keys(value as object).sort()) {
      const inner = (value as Record<string, unknown>)[key]

      if (inner === undefined) {
        continue
      }

      out[key] = canonical(inner)
    }

    return out
  }

  // a function or a symbol has no place in an AST: render it as a marker rather than dropping it silently
  return `<unserializable ${typeof value}>`
}

export function showProgram(program: Program): string {
  return JSON.stringify(canonical(program), undefined, 2)
}

export type CanonicalDiff = {
  path: string
  left: string
  right: string
}

const show = (value: CanonicalValue | undefined): string => {
  if (value === undefined) {
    return '<absent>'
  }

  const text = JSON.stringify(value)

  return text.length > 120 ? `${text.slice(0, 117)}...` : text
}

// walk both trees together and report where they part company. Depth-first in key order, so the first entry is
// the earliest difference in the file rather than an arbitrary one.
export function diffCanonical(
  left: CanonicalValue,
  right: CanonicalValue,
  limit = 20,
  path = '',
  into: CanonicalDiff[] = [],
): CanonicalDiff[] {
  if (into.length >= limit) {
    return into
  }

  const leftArray = Array.isArray(left)
  const rightArray = Array.isArray(right)
  const leftObject =
    left !== null && typeof left === 'object' && !leftArray
  const rightObject =
    right !== null && typeof right === 'object' && !rightArray

  if (leftArray && rightArray) {
    if (left.length !== right.length) {
      into.push({
        path: `${path}.length`,
        left: String(left.length),
        right: String(right.length),
      })
    }

    for (let i = 0; i < Math.max(left.length, right.length); i++) {
      if (into.length >= limit) {
        return into
      }

      const l = left[i]
      const r = right[i]

      if (l === undefined || r === undefined) {
        into.push({ path: `${path}[${i}]`, left: show(l), right: show(r) })
        continue
      }

      diffCanonical(l, r, limit, `${path}[${i}]`, into)
    }

    return into
  }

  if (leftObject && rightObject) {
    const keys = [
      ...new Set([...Object.keys(left), ...Object.keys(right)]),
    ].sort()

    for (const key of keys) {
      if (into.length >= limit) {
        return into
      }

      const l = (left as Record<string, CanonicalValue>)[key]
      const r = (right as Record<string, CanonicalValue>)[key]

      if (l === undefined || r === undefined) {
        into.push({
          path: `${path}.${key}`,
          left: show(l),
          right: show(r),
        })
        continue
      }

      diffCanonical(l, r, limit, `${path}.${key}`, into)
    }

    return into
  }

  if (JSON.stringify(left) !== JSON.stringify(right)) {
    into.push({ path: path || '.', left: show(left), right: show(right) })
  }

  return into
}

// how many nodes of each `form` a program holds, at every depth. The parity gate reports progress per kind, so
// "task is done, match is not" is visible without reading a diff.
export function censusProgram(program: Program): Map<string, number> {
  const counts = new Map<string, number>()

  const walk = (value: unknown): void => {
    if (Array.isArray(value)) {
      value.forEach(walk)

      return
    }

    if (value === null || typeof value !== 'object') {
      return
    }

    const record = value as Record<string, unknown>
    const form = record.form

    if (typeof form === 'string') {
      counts.set(form, (counts.get(form) ?? 0) + 1)
    }

    for (const key of Object.keys(record)) {
      // the CST back-pointer is not part of the AST's shape and would recurse into the whole parse tree
      if (key === 'node') {
        continue
      }

      walk(record[key])
    }
  }

  walk(program as Statement[])

  return counts
}
