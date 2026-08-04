// The unification substitution: the mutable core of type inference, extracted as an atomic, testable component (the
// first step of modularizing the checker out of one large closure). It owns the type-variable bindings, mints fresh
// variables, follows bindings (union-find with path compression), runs the occurs check, and unifies two types.
// `origin` records where a variable was solved, for hover / diagnostics. Pure of diagnostics: `unify` returns a
// boolean, the caller decides how to report a failure. See note/seed/plan/compilation-performance.md (Tier 2).

import type { Type } from '@term/make/code/compile/node'
import type { Span } from '@term/make/code/parser/diagnostic'

export class Substitution {
  private readonly bindings = new Map<number, Type>()
  private next = 0
  // where a variable was solved (span + the type it unified to), for hover and "expected/found" diagnostics
  readonly origin = new Map<number, { span: Span; type: Type }>()

  // a brand-new, unbound type variable
  fresh(): Type {
    return { kind: 'variable', id: this.next++ }
  }

  // follow variable bindings to the current best type, compressing the path so later lookups are O(1)
  resolve(type: Type): Type {
    const chain: number[] = []

    let current = type

    while (current.kind === 'variable') {
      const bound = this.bindings.get(current.id)

      if (!bound) {
        break
      }

      chain.push(current.id)
      current = bound
    }

    for (const id of chain) {
      this.bindings.set(id, current)
    }

    return current
  }

  // does variable `id` appear within `type`? (prevents building an infinite type)
  occurs(id: number, type: Type): boolean {
    const t = this.resolve(type)

    if (t.kind === 'variable') {
      return t.id === id
    }

    if (t.kind === 'function') {
      return (
        t.params.some(p => this.occurs(id, p)) ||
        this.occurs(id, t.result)
      )
    }

    if (t.kind === 'array') {
      return this.occurs(id, t.element)
    }

    if (t.kind === 'map') {
      return this.occurs(id, t.key) || this.occurs(id, t.value)
    }

    if (t.kind === 'named' && t.args) {
      return t.args.some(a => this.occurs(id, a))
    }

    return false
  }

  // unify two types, binding variables as needed. Returns whether they are compatible. `unknown` is gradual (unifies
  // with anything), and so is `dynamic`: it is the host's `any` at the FFI boundary, where values are unchecked by
  // construction, so it is consistent with every type in both directions. A `span` records the solution origin for
  // diagnostics. Recurses structurally.
  unify(a: Type, b: Type, span?: Span): boolean {
    const x = this.resolve(a)
    const y = this.resolve(b)

    if (
      x.kind === 'unknown' ||
      y.kind === 'unknown' ||
      x.kind === 'dynamic' ||
      y.kind === 'dynamic'
    ) {
      return true
    }

    // `number` and `float` are one numeric domain: every arithmetic builtin returns `number`, a fractional literal
    // is a `float`, and both lower to the same host numeric type on every backend. Keeping them apart makes it
    // impossible to compare a computed value against a fractional constant.
    if (
      (x.kind === 'number' || x.kind === 'float') &&
      (y.kind === 'number' || y.kind === 'float')
    ) {
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
          this.bindings.set(y.id, x)
        } else {
          this.bindings.set(x.id, y)
        }

        return true
      }

      if (this.occurs(x.id, y)) {
        return false
      }

      this.bindings.set(x.id, y)

      if (span) {
        this.origin.set(x.id, { span, type: y })
      }

      return true
    }

    if (y.kind === 'variable') {
      if (this.occurs(y.id, x)) {
        return false
      }

      this.bindings.set(y.id, x)

      if (span) {
        this.origin.set(y.id, { span, type: x })
      }

      return true
    }

    if (x.kind === 'function' && y.kind === 'function') {
      if (x.params.length !== y.params.length) {
        return false
      }

      for (let i = 0; i < x.params.length; i++) {
        if (!this.unify(x.params[i]!, y.params[i]!)) {
          return false
        }
      }

      return this.unify(x.result, y.result)
    }

    if (x.kind === 'array' && y.kind === 'array') {
      return this.unify(x.element, y.element)
    }

    if (x.kind === 'map' && y.kind === 'map') {
      return this.unify(x.key, y.key) && this.unify(x.value, y.value)
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

      return xa.every((arg, i) => this.unify(arg, ya[i]!))
    }

    return x.kind === y.kind
  }
}
