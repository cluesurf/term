/**
 * The bridge from the live compiler to the property engine: turn the
 * compiler's real type IR (`Type` from @term/make/code/compile/
 * node) into a generator. This is the integration step that makes
 * property testing work on ACTUAL parsed-and-checked Seed types, not a
 * hand-written `SeedType` - "read the compiler's real type IR in
 * genForType" from the build plan.
 *
 * It translates the compiler `Type` into the engine's `SeedType` and
 * reuses `genForType`, so the derivation logic lives in one place. A
 * record (`named` type) needs its field list, supplied via the
 * `RecordTable` the checker already builds.
 */

import type { Type } from '@term/make/code/compile/node'
import { genForType, type SeedType, tInt, tWave, tText, tList, tRecord, tWhole } from './type'
import { type Gen } from './property'

/** Named record types -> their fields, as the checker tracks them. */
export type RecordTable = Map<string, { name: string; type: Type }[]>

/**
 * Translate a compiler `Type` into the engine's `SeedType`. Floats map
 * to ints for generation (the bounded engine is integer-valued today);
 * `dynamic`/`unknown`/`unit` fall back to a whole. A `named` type
 * resolves through the record table when it is a record; otherwise it
 * is treated as an opaque whole (enums and abstract types).
 */
export function irToSeedType(type: Type, records: RecordTable): SeedType {
  switch (type.kind) {
    case 'number':
      return tInt
    case 'float':
      return tInt
    case 'boolean':
      return tWave
    case 'string':
      return tText
    case 'array':
      return tList(irToSeedType(type.element, records))
    case 'named': {
      const fields = records.get(type.name)
      if (fields) {
        return tRecord(
          fields.map(field => ({
            name: field.name,
            type: irToSeedType(field.type, records),
          })),
        )
      }
      return tWhole
    }
    default:
      // unit, unknown, dynamic, bytes, map, function, variable
      return tWhole
  }
}

/** Derive a generator directly from a compiler `Type`. */
export function genFromIR(type: Type, records: RecordTable): Gen<unknown> {
  return genForType(irToSeedType(type, records))
}
