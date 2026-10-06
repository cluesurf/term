// A function's signature instantiated: its generic variables freshened against a substitution (Hindley-Milner
// let-polymorphism), so a generic function can be called at different types. A signature is the firewall boundary:
// callers depend on a callee's signature, never its body. See note/seed/plan/compilation-performance.md (Tier 2).
//
// The checker's signature record holds sets and the parameters' defaults, and stays the checker's (check/infer.ts
// `Signature`, `instantiate`); this is the part that does the work, the shape check/signature.tree has: handed the
// generic and hole ids as lists, it answers the new types with each generic's fresh variable, from which the checker
// reads the bounds.

import type { Type } from '@term/make/code/compile/node'
import type { Substitution } from '@term/make/code/check/substitution'
import { freshType, resolveType } from '@term/make/code/check/substitution'

export type InstantiatedTypes = {
  params: Type[]
  result: Type
  // the fresh variable each generic (and each hole met) was given, by the variable it replaces
  fresh: Map<number, Type>
}

export function instantiateTypes(
  generics: number[],
  holes: number[],
  params: Type[],
  result: Type,
  sub: Substitution,
): InstantiatedTypes {
  const map = new Map<number, Type>()
  const holeSet = new Set(holes)

  for (const id of generics) {
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
    if (type.kind === 'variable' && holeSet.has(type.id)) {
      const r = resolveType(sub, type)

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

    const r = resolveType(sub, type)

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

    // a named type with arguments is built anew from its name and freshened arguments; one with none is kept as it
    // stands, its value arguments with it. Until the port it was rebuilt whenever `args` was present, so an empty
    // `args` dropped the value arguments, and a Term `need false` list cannot be told present and empty from absent
    if (r.kind === 'named' && r.args?.length) {
      return { kind: 'named', name: r.name, args: r.args.map(subst) }
    }

    return r
  }

  return { params: params.map(subst), result: subst(result), fresh: map }
}
