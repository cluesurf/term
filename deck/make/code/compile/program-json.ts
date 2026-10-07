// One canonical serialization of a `Program`, so two paths that claim to build the same AST can be held to it
// byte for byte (mint-bridge-0001). The hand-written `compile/mill.ts` and the grammar-driven executor both
// produce a `Program`; `pnpm term:mint-parity` renders each through here and diffs the text.
//
// Everything it decides is Term, compile/program-canon.tree (self-hosting, 2026-10-07): keys sorted, a key holding
// `undefined` dropped, a bigint tagged, `-0` as `0`, the text of a canonical value, the diff by path and the census by
// form. This face reads a host value into the port's `raw-value` (its own keys, in the order the host gives them) and
// hands the canonical value back as plain objects. The header of the port says why each rule is what it is.

import type { Program } from '@term/make/code/compile/node'
import * as canon from '@term/make/code/compile/program-canon'

export type CanonicalValue =
  | null
  | boolean
  | number
  | string
  | CanonicalValue[]
  | { [key: string]: CanonicalValue }

// a host value as the port reads it. `omit` is a key left out wherever it stands (the census's CST back-pointer)
function rawOf(value: unknown, omit?: string): canon.RawValue {
  if (value === undefined) {
    return { form: 'raw-undefined' }
  }

  if (value === null) {
    return { form: 'raw-null' }
  }

  switch (typeof value) {
    case 'bigint':
      return { form: 'raw-bigint', digits: value.toString() }
    case 'boolean':
      return { form: 'raw-flag', value }
    case 'string':
      return { form: 'raw-text', value }
    case 'number':
      return { form: 'raw-number', value }
    case 'object':
      break
    default:
      return { form: 'raw-other', kind: typeof value }
  }

  if (Array.isArray(value)) {
    return { form: 'raw-items', items: value.map(item => rawOf(item, omit)) }
  }

  const pairs: canon.RawPair[] = []

  for (const key of Object.keys(value as object)) {
    if (key === omit) {
      continue
    }

    pairs.push({ key, value: rawOf((value as Record<string, unknown>)[key], omit) })
  }

  return { form: 'raw-record', pairs }
}

// a canonical value as plain objects. A key is defined, never assigned, so a key named `__proto__` stays a key
function plainOf(value: canon.CanonicalValue): CanonicalValue {
  switch (value.form) {
    case 'canon-null':
      return null
    case 'canon-flag':
    case 'canon-number':
    case 'canon-text':
      return value.value
    case 'canon-items':
      return value.items.map(plainOf)
    case 'canon-record': {
      const out: { [key: string]: CanonicalValue } = {}

      for (const pair of value.pairs) {
        Object.defineProperty(out, pair.key, {
          value: plainOf(pair.value),
          enumerable: true,
          writable: true,
          configurable: true,
        })
      }

      return out
    }
  }
}

export function canonical(value: unknown): CanonicalValue {
  return plainOf(canon.canonicalOf(rawOf(value)))
}

export function showProgram(program: Program): string {
  return canon.showProgram(canon.canonicalOf(rawOf(program)))
}

export type CanonicalDiff = {
  path: string
  left: string
  right: string
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
  const found = canon.diffCanonical(
    canon.canonicalOf(rawOf(left)),
    canon.canonicalOf(rawOf(right)),
    limit,
    path,
    into.length,
  )

  into.push(...found)

  return into
}

// how many nodes of each `form` a program holds, at every depth. The parity gate reports progress per kind, so
// "task is done, match is not" is visible without reading a diff.
export function censusProgram(program: Program): Map<string, number> {
  const counts = new Map<string, number>()

  for (const { form, count } of canon.censusRaw(rawOf(program, 'node'))) {
    counts.set(form, count)
  }

  return counts
}
