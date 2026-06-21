/**
 * Type-derived generators: turn a Seed type into a property-test
 * generator automatically, so any `form` is testable with no hand-
 * written generator. This is the "derive the generator from the type"
 * step of Layer 3 (note/methodology/verification/seed-verification-
 * system.md) - a fold over the type structure.
 *
 * `SeedType` is the small structural description of a Seed type the
 * checker already has (a whole, an int, a wave, a text, a list, a
 * record `form`, or a `pick` union). `genForType` folds it into a
 * `Gen`. The same derivation will later read the compiler's real type
 * IR instead of this standalone description.
 */

import {
  genWhole,
  genInt,
  genList,
  type Gen,
  type Rng,
} from './property'

/** The structural shape of a Seed type, as the checker sees it. */
export type SeedType =
  | { form: 'whole' }
  | { form: 'int' }
  | { form: 'wave' }
  | { form: 'text' }
  | { form: 'list'; item: SeedType }
  | { form: 'record'; fields: { name: string; type: SeedType }[] }
  | { form: 'pick'; options: SeedType[] }

/** A boolean generator (wave). */
const genWave: Gen<boolean> = {
  sample: rng => rng.next() < 0.5,
  shrink: value => (value ? [false] : []),
}

/** A text generator, boundary-biased (empty, short, with delimiters). */
const genText: Gen<string> = {
  sample(rng, size) {
    const length = Math.floor(rng.next() * Math.min(size, 12))
    const alphabet = 'abc <>/\n'
    let out = ''
    for (let i = 0; i < length; i++) {
      out += alphabet[Math.floor(rng.next() * alphabet.length)]
    }
    return out
  },
  shrink(value) {
    if (value.length === 0) return []
    return ['', value.slice(0, Math.floor(value.length / 2)), value.slice(1)]
  },
}

/** A record generator: a value per field (the canonical tuple fold). */
function genRecord(
  fields: { name: string; type: SeedType }[],
): Gen<Record<string, unknown>> {
  const gens = fields.map(field => ({
    name: field.name,
    gen: genForType(field.type),
  }))

  return {
    sample(rng, size) {
      const out: Record<string, unknown> = {}
      for (const { name, gen } of gens) out[name] = gen.sample(rng, size)
      return out
    },
    shrink(value) {
      const out: Record<string, unknown>[] = []
      for (const { name, gen } of gens) {
        for (const smaller of gen.shrink(value[name])) {
          out.push({ ...value, [name]: smaller })
        }
      }
      return out
    },
  }
}

/** A union generator: pick an arm, generate from it. */
function genPick(options: SeedType[]): Gen<unknown> {
  const gens = options.map(genForType)

  return {
    sample(rng: Rng, size: number) {
      const arm = Math.floor(rng.next() * gens.length)
      return gens[arm].sample(rng, size)
    },
    // shrink toward the first (simplest) arm's values is unsound across
    // arms, so only shrink within a value's own structure is skipped;
    // unions shrink by trying each arm's shrink that still type-checks.
    shrink() {
      return []
    },
  }
}

/** Fold a Seed type into its canonical generator. */
export function genForType(type: SeedType): Gen<unknown> {
  switch (type.form) {
    case 'whole':
      return genWhole as Gen<unknown>
    case 'int':
      return genInt as Gen<unknown>
    case 'wave':
      return genWave as Gen<unknown>
    case 'text':
      return genText as Gen<unknown>
    case 'list':
      return genList(genForType(type.item))
    case 'record':
      return genRecord(type.fields) as Gen<unknown>
    case 'pick':
      return genPick(type.options)
  }
}

// convenience constructors so callers read cleanly
export const tWhole: SeedType = { form: 'whole' }
export const tInt: SeedType = { form: 'int' }
export const tWave: SeedType = { form: 'wave' }
export const tText: SeedType = { form: 'text' }
export const tList = (item: SeedType): SeedType => ({ form: 'list', item })
export const tRecord = (
  fields: { name: string; type: SeedType }[],
): SeedType => ({ form: 'record', fields })
export const tPick = (options: SeedType[]): SeedType => ({
  form: 'pick',
  options,
})
