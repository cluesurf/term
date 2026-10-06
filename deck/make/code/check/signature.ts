// A function's type signature in the checker, plus instantiation. Extracted from the inference closure as the second
// atomic component of the modular checker. A signature is the firewall boundary: callers depend on a callee's
// signature, never its body. `instantiate` freshens a signature's generic variables (Hindley-Milner let-polymorphism)
// against a substitution, so a generic function can be called at different types. See note/seed/plan/compilation-performance.md (Tier 2).

import type { Expression, Type } from '@term/make/code/compile/node'
import type { Substitution } from '@term/make/code/check/substitution'
import { freshType, resolveType } from '@term/make/code/check/substitution'

export type Signature = {
  // the ids of this signature's generic type variables
  generics: Set<number>
  // each generic variable id to its declared name (for nice generic output)
  genericNames: Map<number, string>
  // each generic variable id to its trait bound (`need`), if any
  bounds: Map<number, string>
  params: Type[]
  result: Type
  // the minimum call arity: trailing optional (`need false`) params may be omitted
  minArgs: number
  // the parameters' names, defaults and positional-only flags, aligned with `params`, so a call can name its
  // arguments, omit one that has a `fall`, and be refused a name on a `slot`
  names: string[]
  fallbacks: (Expression | undefined)[]
  positional: boolean[]
  // which parameters are `need false`: one left out between two given ones takes its empty value, as a trailing one does
  optional?: boolean[]
  // HOLES: the variables a generic signature's bare forms were seeded with (`like maybe`, `like signal`), which are not
  // among `generics`. One per signature, so every call shared it until each call was given its own (native-dom-0046)
  holes?: Set<number>
}

export type Instantiated = {
  params: Type[]
  result: Type
  bounds: { variable: Type; mask: string }[]
  minArgs: number
  names: string[]
  fallbacks: (Expression | undefined)[]
  positional: boolean[]
  optional?: boolean[]
}

// instantiate a signature, freshening its generics via `sub`. A non-generic signature is returned as-is.
export function instantiate(
  signature: Signature,
  sub: Substitution,
): Instantiated {
  if (signature.generics.size === 0) {
    return {
      params: signature.params,
      result: signature.result,
      bounds: [],
      minArgs: signature.minArgs,
      names: signature.names,
      fallbacks: signature.fallbacks,
      positional: signature.positional,
      optional: signature.optional,
    }
  }

  const map = new Map<number, Type>()

  for (const id of signature.generics) {
    map.set(id, freshType(sub))
  }

  const subst = (type: Type): Type => {
    // a declared generic freshens by its raw id, before consulting the substitution: even if body checking solved
    // the generic against some metavariable, each call site must still get its own fresh copy
    if (type.kind === 'variable' && map.has(type.id)) {
      return map.get(type.id)!
    }

    // a HOLE (a bare form's argument, `like signal` where `like signal t` was meant) is what the body made of it:
    // linked to a declared generic, it takes that generic's fresh copy; still free, because no body has been checked
    // yet (a module-level `host` is checked before every function), it takes a fresh variable of this call's own.
    // Shared, the first call to bind it decided it for the whole program (native-dom-0044, 0046)
    if (type.kind === 'variable' && signature.holes?.has(type.id)) {
      const r = resolveType(sub,type)

      if (r.kind === 'variable') {
        if (map.has(r.id)) {
          return map.get(r.id)!
        }

        const fresh = freshType(sub)
        map.set(r.id, fresh)

        return fresh
      }

      return subst(r)
    }

    const r = resolveType(sub,type)

    if (r.kind === 'variable') {
      return map.get(r.id) ?? r
    }

    if (r.kind === 'array') {
      return { kind: 'array', element: subst(r.element) }
    }

    if (r.kind === 'map') {
      return { kind: 'map', key: subst(r.key), value: subst(r.value) }
    }

    if (r.kind === 'function') {
      return {
        kind: 'function',
        params: r.params.map(subst),
        result: subst(r.result),
        effects: r.effects,
      }
    }

    if (r.kind === 'named' && r.args) {
      return { kind: 'named', name: r.name, args: r.args.map(subst) }
    }

    return r
  }

  const bounds = [...signature.bounds].map(([id, mask]) => ({
    variable: map.get(id)!,
    mask,
  }))

  return {
    params: signature.params.map(subst),
    result: subst(signature.result),
    bounds,
    minArgs: signature.minArgs,
    names: signature.names,
    fallbacks: signature.fallbacks,
    positional: signature.positional,
    optional: signature.optional,
  }
}
