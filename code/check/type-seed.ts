// Type seeding: turn a milled type annotation into a fresh inference type (unknowns become fresh variables, generic
// names map to their variables, `list` / `hash` become array / map, a form gets a fresh type argument per parameter).
// Extracted from the inference closure as a component of the modular checker. A factory, so the checker keeps owning
// the `records` / `formGenerics` tables (shared with expression inference) and the algorithm lives here.
// See note/seed/plan/compilation-performance.md (Tier 2).

import type { Type } from '@/code/compile/node'
import { UNKNOWN } from '@/code/compile/node'
import type { Substitution } from '@/code/check/substitution'

export type SeedType = (
  type: Type | undefined,
  generics: Map<string, Type>,
) => Type

export function makeSeedType(
  sub: Substitution,
  records: Map<string, Map<string, Type>>,
  formGenerics: Map<string, Array<string>>,
): SeedType {
  const seed: SeedType = (type, generics) => {
    if (!type) return sub.fresh()
    if (type.kind === 'named') {
      const generic = generics.get(type.name)
      if (generic) return generic
      // `list` is the native array type: `like list` is array<unknown>, `like list<t>` is array<t>
      if (type.name === 'list')
        return {
          kind: 'array',
          element: type.args?.[0] ? seed(type.args[0], generics) : UNKNOWN,
        }
      // `hash` is the native map type: `like hash<k, v>` is map<k, v>, `like hash` is map<unknown, unknown>
      if (type.name === 'hash')
        return {
          kind: 'map',
          key: type.args?.[0] ? seed(type.args[0], generics) : UNKNOWN,
          value: type.args?.[1] ? seed(type.args[1], generics) : UNKNOWN,
        }
      if (records.has(type.name)) {
        // a form: give it a fresh type argument per generic parameter (maybe -> maybe<?a>), inferred from usage
        const params = formGenerics.get(type.name) ?? []
        return {
          kind: 'named',
          name: type.name,
          args: params.map((_, i) => seed(type.args?.[i], generics)),
        }
      }
      return sub.fresh() // an unrecognized name: infer it from usage rather than forcing a mismatch
    }
    if (type.kind === 'array')
      return { kind: 'array', element: seed(type.element, generics) }
    if (type.kind === 'map')
      return {
        kind: 'map',
        key: seed(type.key, generics),
        value: seed(type.value, generics),
      }
    if (type.kind === 'function')
      return {
        kind: 'function',
        params: type.params.map(p => seed(p, generics)),
        result: seed(type.result, generics),
        effects: type.effects,
      }
    return type
  }
  return seed
}
