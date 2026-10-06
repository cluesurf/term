// The unification substitution: the mutable core of type inference, extracted as an atomic, testable component (the
// first step of modularizing the checker out of one large closure). It owns the type-variable bindings, mints fresh
// variables, follows bindings (union-find with path compression), runs the occurs check, and unifies two types.
// `origin` records where a variable was solved, for hover / diagnostics. Pure of diagnostics: unifying answers a
// boolean, the caller decides how to report a failure. See note/seed/plan/compilation-performance.md (Tier 2).
//
// A record and functions over it, the shape check/substitution.tree has, where it was a class: a unify that records
// where a variable was solved is `unifyTypesAt`, with the span.

import type { Type } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'

// where a variable was solved: the span and the type it unified to
export type Solved = { span: Span; type: Type }

export type Substitution = {
  bindings: Map<number, Type>
  next: number
  // where a variable was solved, for hover and "expected/found" diagnostics
  origin: Map<number, Solved>
}

export function newSubstitution(): Substitution {
  return { bindings: new Map(), next: 0, origin: new Map() }
}

// a brand-new, unbound type variable
export function freshType(sub: Substitution): Type {
  return { kind: 'variable', id: sub.next++ }
}

// follow variable bindings to the current best type, compressing the path so later lookups are O(1)
export function resolveType(sub: Substitution, type: Type): Type {
  const chain: number[] = []

  let current = type

  while (current.kind === 'variable') {
    const bound = sub.bindings.get(current.id)

    if (!bound) {
      break
    }

    chain.push(current.id)
    current = bound
  }

  for (const id of chain) {
    sub.bindings.set(id, current)
  }

  return current
}

// does variable `id` appear within `type`? (prevents building an infinite type)
export function occursIn(sub: Substitution, id: number, type: Type): boolean {
  const t = resolveType(sub, type)

  if (t.kind === 'variable') {
    return t.id === id
  }

  if (t.kind === 'function') {
    return t.params.some(p => occursIn(sub, id, p)) || occursIn(sub, id, t.result)
  }

  if (t.kind === 'array') {
    return occursIn(sub, id, t.element)
  }

  if (t.kind === 'map') {
    return occursIn(sub, id, t.key) || occursIn(sub, id, t.value)
  }

  if (t.kind === 'named' && t.args) {
    return t.args.some(a => occursIn(sub, id, a))
  }

  return false
}

// unify two types, binding variables as needed. Answers whether they are compatible. `unknown` is gradual (unifies
// with anything), and so is `dynamic`: it is the host's `any` at the FFI boundary, where values are unchecked by
// construction, so it is consistent with every type in both directions. Recurses structurally.
export function unifyTypes(sub: Substitution, a: Type, b: Type): boolean {
  return unifyWith(sub, a, b, undefined)
}

// the same, recording `at` as where a variable this solves was solved, for diagnostics
export function unifyTypesAt(sub: Substitution, a: Type, b: Type, at: Span): boolean {
  return unifyWith(sub, a, b, at)
}

function unifyWith(sub: Substitution, a: Type, b: Type, span: Span | undefined): boolean {
  const x = resolveType(sub, a)
  const y = resolveType(sub, b)

  if (x.kind === 'unknown' || y.kind === 'unknown' || x.kind === 'dynamic' || y.kind === 'dynamic') {
    return true
  }

  // `number` and `float` unify, so arithmetic and comparison can mix a computed value with a fractional constant.
  // They are not one type: `number` is `i64` on Rust, Swift and Kotlin and `float` is `f64`. The direction is
  // held where a value meets the type it is wanted as (check/expect.ts): a whole number widens to a fraction, and
  // a fraction where a whole number is wanted is refused.
  if ((x.kind === 'number' || x.kind === 'float') && (y.kind === 'number' || y.kind === 'float')) {
    return true
  }

  if (x.kind === 'variable') {
    if (y.kind === 'variable') {
      if (y.id === x.id) {
        return true
      }

      // bind the younger variable to the older one: a callee's freshly instantiated metavariable must never
      // solve an enclosing signature's generic, or later instantiations of that signature resolve through the
      // stale binding and every call site shares one variable (the forwarding-bounded-generic bug)
      if (y.id > x.id) {
        sub.bindings.set(y.id, x)
      } else {
        sub.bindings.set(x.id, y)
      }

      return true
    }

    return bindVariable(sub, x.id, y, span)
  }

  if (y.kind === 'variable') {
    return bindVariable(sub, y.id, x, span)
  }

  if (x.kind === 'function' && y.kind === 'function') {
    if (x.params.length !== y.params.length) {
      return false
    }

    for (let i = 0; i < x.params.length; i++) {
      if (!unifyTypes(sub, x.params[i]!, y.params[i]!)) {
        return false
      }
    }

    return unifyTypes(sub, x.result, y.result)
  }

  if (x.kind === 'array' && y.kind === 'array') {
    return unifyTypes(sub, x.element, y.element)
  }

  if (x.kind === 'map' && y.kind === 'map') {
    return unifyTypes(sub, x.key, y.key) && unifyTypes(sub, x.value, y.value)
  }

  if (x.kind === 'named' && y.kind === 'named') {
    if (x.name !== y.name) {
      return false
    }

    const xa = x.args ?? []
    const ya = y.args ?? []

    if (xa.length !== ya.length) {
      return true
    } // one side unparameterized: gradual

    return xa.every((arg, i) => unifyTypes(sub, arg, ya[i]!))
  }

  return x.kind === y.kind
}

function bindVariable(sub: Substitution, id: number, to: Type, span: Span | undefined): boolean {
  if (occursIn(sub, id, to)) {
    return false
  }

  sub.bindings.set(id, to)

  if (span) {
    sub.origin.set(id, { span, type: to })
  }

  return true
}
