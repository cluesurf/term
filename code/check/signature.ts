// A function's type signature in the checker, plus instantiation. Extracted from the inference closure as the second
// atomic component of the modular checker. A signature is the firewall boundary: callers depend on a callee's
// signature, never its body. `instantiate` freshens a signature's generic variables (Hindley-Milner let-polymorphism)
// against a substitution, so a generic function can be called at different types. See note/seed/plan/compilation-performance.md (Tier 2).

import type { Type } from '@/code/compile/node'
import type { Substitution } from '@/code/check/substitution'

export type Signature = {
  // the ids of this signature's generic type variables
  generics: Set<number>
  // each generic variable id to its declared name (for nice generic output)
  genericNames: Map<number, string>
  // each generic variable id to its trait bound (`need`), if any
  bounds: Map<number, string>
  params: Array<Type>
  result: Type
  // the minimum call arity: trailing optional (`need false`) params may be omitted
  minArgs: number
}

export type Instantiated = {
  params: Array<Type>
  result: Type
  bounds: Array<{ variable: Type; mask: string }>
  minArgs: number
}

// instantiate a signature, freshening its generics via `sub`. A non-generic signature is returned as-is.
export function instantiate(
  signature: Signature,
  sub: Substitution,
): Instantiated {
  if (signature.generics.size === 0)
    return {
      params: signature.params,
      result: signature.result,
      bounds: [],
      minArgs: signature.minArgs,
    }
  const map = new Map<number, Type>()
  for (const id of signature.generics) map.set(id, sub.fresh())
  const subst = (type: Type): Type => {
    const r = sub.resolve(type)
    if (r.kind === 'variable') return map.get(r.id) ?? r
    if (r.kind === 'array')
      return { kind: 'array', element: subst(r.element) }
    if (r.kind === 'map')
      return { kind: 'map', key: subst(r.key), value: subst(r.value) }
    if (r.kind === 'function')
      return {
        kind: 'function',
        params: r.params.map(subst),
        result: subst(r.result),
        effects: r.effects,
      }
    if (r.kind === 'named' && r.args)
      return { kind: 'named', name: r.name, args: r.args.map(subst) }
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
  }
}
