// Type seeding: turn a milled type annotation into a fresh inference type (unknowns become fresh variables, generic
// names map to their variables, `list` / `hash` become array / map, a form gets a fresh type argument per parameter).
// Extracted from the inference closure as a component of the modular checker. A factory, so the checker keeps owning
// the `records` / `formGenerics` tables (shared with expression inference) and the algorithm lives here.
// See note/seed/plan/compilation-performance.md (Tier 2).

import type { Type } from '@term/make/code/compile/node'
import { UNKNOWN } from '@term/make/code/compile/node'
import type { Substitution } from '@term/make/code/check/substitution'

export type SeedType = (
  type: Type | undefined,
  generics: Map<string, Type>,
) => Type

export function makeSeedType(
  sub: Substitution,
  records: Map<string, Map<string, Type>>,
  formGenerics: Map<string, string[]>,
  // opaque per-backend handle types (`dock type`): kept as named types so a backend resolves them to a concrete
  // handle, rather than being inferred as a fresh generic variable
  opaqueTypes = new Set<string>(),
): SeedType {
  const seed: SeedType = (type, generics) => {
    if (!type) {
      return sub.fresh()
    }

    if (type.kind === 'named') {
      const generic = generics.get(type.name)

      if (generic) {
        return generic
      }

      // `list` is the native array type: `like list<t>` is array<t>, and a BARE `like list` leaves the element a
      // fresh inference variable filled from usage -- a native backend then emits the concrete element instead of
      // the boxed dynamic (`SeedList<String>`, never `SeedList<Any>`). A list that genuinely mixes elements says
      // so: `like list, like unknown`.
      if (type.name === 'list') {
        return {
          kind: 'array',
          element: type.args?.[0]
            ? seed(type.args[0], generics)
            : sub.fresh(),
        }
      }

      // `hash` is the native map type, with the same rule: `like hash<k, v>` is map<k, v>, and a bare `like hash`
      // infers its key and value from usage
      if (type.name === 'hash') {
        return {
          kind: 'map',
          key: type.args?.[0] ? seed(type.args[0], generics) : sub.fresh(),
          value: type.args?.[1]
            ? seed(type.args[1], generics)
            : sub.fresh(),
        }
      }

      if (records.has(type.name)) {
        // a form: give it a fresh type argument per generic parameter (maybe -> maybe<?a>), inferred from usage. An
        // indexed family's VALUE-INDEX arguments (`vec a n`) are carried verbatim -- they are expressions, not
        // inference types, so they pass through untouched and keep the type value-dependent through inference.
        const params = formGenerics.get(type.name) ?? []

        return {
          kind: 'named',
          name: type.name,
          args: params.map((_, i) => seed(type.args?.[i], generics)),
          ...(type.valueArgs ? { valueArgs: type.valueArgs } : {}),
        }
      }

      // an opaque handle type stays named, so each backend resolves it to its concrete per-env type
      if (opaqueTypes.has(type.name)) {
        return { kind: 'named', name: type.name }
      }

      // `unknown` is the GRADUAL type: consistent with every type, in both directions. It is what a function that
      // genuinely accepts any Term value declares (`deep-equal` narrows its args with a runtime shape test), and is
      // distinct from `dynamic`, which is the host's `any` at the FFI boundary.
      if (type.name === 'unknown') {
        return UNKNOWN
      }

      // `type` is the UNIVERSE (the type of types): kept named, so a function may take or return one (`El : U -> type`,
      // the decoder of a universe-as-data / induction-recursion) rather than inferring it as a fresh variable.
      if (type.name === 'type') {
        return { kind: 'named', name: 'type' }
      }

      return sub.fresh() // an unrecognized name: infer it from usage rather than forcing a mismatch
    }

    if (type.kind === 'array') {
      return { kind: 'array', element: seed(type.element, generics) }
    }

    // a slot the source left empty (`free`): a fresh variable, filled from usage; a spelled `like unknown` stays
    // the gradual type
    if (type.kind === 'unknown' && type.free) {
      return sub.fresh()
    }

    if (type.kind === 'map') {
      return {
        kind: 'map',
        key: seed(type.key, generics),
        value: seed(type.value, generics),
      }
    }

    if (type.kind === 'function') {
      return {
        kind: 'function',
        params: type.params.map(p => seed(p, generics)),
        result: seed(type.result, generics),
        effects: type.effects,
        paramNames: type.paramNames,
      }
    }

    return type
  }

  return seed
}
