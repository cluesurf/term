// Record conversion: the change set that moves a dataset from one version of a form to
// the next.
//
// Registering a new version of a form changes what the validator checks from then on
// and touches no record, so every old record that no longer fits fails on its NEXT
// commit. This is the missing piece: a closed vocabulary of four moves, applied over
// the records of one form, producing ordinary `field.set` / `field.remove` changes that
// go through the ordinary commit path and are validated against the new version like
// anything else. The vocabulary is closed for the reason the constraint vocabulary is:
// any implementation applies it identically, and a conversion is data that versions
// with the form rather than code somebody has to run.
//
//   from     copy another property's value in. A rename when the source is not a
//            property of the new version (the old field is removed), a copy otherwise
//   wrap     a single value becomes a one-member collection of the given kind
//   unwrap   a collection becomes its first member; an empty one becomes absence
//   cast     between the scalar kinds by the canonical rules below, refusing what does
//            not convert rather than guessing
//   default  a value for a record that has none after the other moves
//
// A property with no move is left as it is. What the four cannot express (a split, a
// merge, a computed value) is the converter chain in restructuring-records.md: a program
// the owner runs, emitting its own change set through the same commit path.
//
// See note/project/base/design/record-conversion.md.

import type { CollectionKind, Mark, RecordNode, Value } from '@cluesurf/save/base/type'
import type { Change, Dataset } from '@cluesurf/save/diff/change'
import type { Property } from '@cluesurf/save/form/form'
import { canonicalizeValue } from '@cluesurf/save/canon/canonicalize'
import {
  boolean,
  collection,
  date,
  decimal,
  integer,
  item,
  nul,
  text,
  valueOf,
} from '@cluesurf/save/base/make'

/** The scalar kinds a value may be cast to. */
export type Cast = 'text' | 'integer' | 'decimal' | 'boolean' | 'date'

/** The moves one property may carry. Applied in the order the fields are listed. */
export type Move = {
  from?: string
  unwrap?: boolean
  wrap?: CollectionKind
  cast?: Cast
  // a plain JS value, lifted through `valueOf`; `null` is an explicit null
  default?: unknown
}

/** A conversion: moves keyed by the property they produce. */
export type Conversion = Record<string, Move>

/** One record the moves could not make fit, and why. */
export type ConversionFault = {
  mark: Mark
  property: string
  why: string
}

export type Converted = {
  changes: Array<Change>
  faults: Array<ConversionFault>
}

const INTEGER = /^[+-]?\d+$/

const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/

// a decimal that is a whole number, so it may become an integer without loss
const WHOLE = /^([+-]?\d+)(\.0*)?$/

const BOOLEAN: Record<string, boolean> = { true: true, false: false }

type CastAnswer = { ok: true; value: Value } | { ok: false; why: string }

/**
 * Cast a scalar between kinds by the canonical rules, or say why not.
 *
 * Text is the universal source: an integer, decimal, boolean or date is parsed from it
 * by the same grammar the canonical form uses, and a text that does not parse is a
 * refusal rather than a zero. Every scalar becomes text by its canonical spelling. A
 * null is left a null: absence of a value is not a value to convert. Anything else (a
 * collection, a nested record, a reference, a blob) has no scalar reading and refuses.
 */
export function castValue(value: Value, to: Cast): CastAnswer {
  if (value.kind === 'null') {
    return { ok: true, value }
  }

  if (value.kind === to) {
    return { ok: true, value }
  }

  switch (value.kind) {
    case 'text':
      return castText(value.value, to)
    case 'integer':
      switch (to) {
        case 'text':
          return { ok: true, value: text(value.value.toString()) }
        case 'decimal':
          return { ok: true, value: decimal(value.value.toString()) }
        default:
          return { ok: false, why: `an integer does not cast to ${to}` }
      }
    case 'decimal':
      switch (to) {
        case 'text':
          return { ok: true, value: text(value.value) }
        case 'integer': {
          const whole = WHOLE.exec(value.value)

          return whole
            ? { ok: true, value: integer(BigInt(whole[1]!)) }
            : { ok: false, why: `decimal ${value.value} is not a whole number` }
        }
        default:
          return { ok: false, why: `a decimal does not cast to ${to}` }
      }
    case 'boolean':
      return to === 'text'
        ? { ok: true, value: text(value.value ? 'true' : 'false') }
        : { ok: false, why: `a boolean does not cast to ${to}` }
    case 'date':
      return to === 'text'
        ? { ok: true, value: text(value.value) }
        : { ok: false, why: `a date does not cast to ${to}` }
    default:
      return { ok: false, why: `a ${value.kind} has no scalar reading` }
  }
}

function castText(source: string, to: Cast): CastAnswer {
  switch (to) {
    case 'text':
      return { ok: true, value: text(source) }
    case 'integer':
      return INTEGER.test(source)
        ? { ok: true, value: integer(BigInt(source)) }
        : { ok: false, why: `text ${JSON.stringify(source)} is not an integer` }
    case 'decimal':
      return DECIMAL.test(source)
        ? { ok: true, value: decimal(source) }
        : { ok: false, why: `text ${JSON.stringify(source)} is not a decimal` }
    case 'boolean':
      return source in BOOLEAN
        ? { ok: true, value: boolean(BOOLEAN[source]!) }
        : { ok: false, why: `text ${JSON.stringify(source)} is not true or false` }
    case 'date':
      return Number.isFinite(Date.parse(source))
        ? { ok: true, value: date(source) }
        : { ok: false, why: `text ${JSON.stringify(source)} is not a date` }
  }
}

function same(a: Value | undefined, b: Value | undefined): boolean {
  if (a === undefined || b === undefined) {
    return a === b
  }

  return canonicalizeValue(a) === canonicalizeValue(b)
}

/**
 * The moves of one property over one record: the value it ends with (undefined for
 * absence), the source field a rename removes, or a fault.
 */
function moveOne(input: {
  record: RecordNode
  property: string
  move: Move
  declared: Set<string>
}):
  | { ok: true; value: Value | undefined; removes?: string }
  | { ok: false; why: string } {
  const { record, property, move } = input
  let value = record.fields.get(property)
  let removes: string | undefined

  if (move.from !== undefined) {
    const source = record.fields.get(move.from)

    if (source !== undefined) {
      value = source

      // a rename, when the old name is gone from the new version; a copy otherwise
      if (!input.declared.has(move.from) && move.from !== property) {
        removes = move.from
      }
    }
  }

  if (move.unwrap && value?.kind === 'collection') {
    value = value.items[0]?.value
  }

  if (move.wrap !== undefined && value !== undefined && value.kind !== 'collection') {
    value = collection(move.wrap, [item(value)])
  }

  if (move.cast !== undefined && value !== undefined) {
    const cast = castValue(value, move.cast)

    if (!cast.ok) {
      return cast
    }

    value = cast.value
  }

  if (value === undefined && 'default' in move) {
    value = valueOf(move.default) ?? nul()
  }

  return removes === undefined ? { ok: true, value } : { ok: true, value, removes }
}

/**
 * The change set that converts every record of `form` in a dataset by the moves.
 *
 * Pure: reads the dataset, writes nothing, and answers the changes beside the records
 * the moves could not make fit. A caller with any fault writes nothing, because a
 * conversion that half-lands leaves a dataset no version describes.
 *
 * `properties` are the NEW version's, so `from` can tell a rename from a copy. A
 * record with no mark cannot be addressed by a change and is skipped: it cannot be in a
 * dataset in the first place.
 */
export function convertDataset(input: {
  dataset: Dataset
  form: string
  properties: Array<Property>
  convert: Conversion
}): Converted {
  const changes: Array<Change> = []
  const faults: Array<ConversionFault> = []
  const declared = new Set(input.properties.map(property => property.name))
  const moves = Object.entries(input.convert)

  for (const record of input.dataset.values()) {
    if (record.type !== input.form || record.mark === undefined) {
      continue
    }

    const mark = record.mark
    const mine: Array<Change> = []
    let bad = false

    for (const [property, move] of moves) {
      const moved = moveOne({ record, property, move, declared })

      if (!moved.ok) {
        faults.push({ mark, property, why: moved.why })
        bad = true
        continue
      }

      const before = record.fields.get(property)

      if (moved.value === undefined) {
        if (before !== undefined) {
          mine.push({ type: 'field.remove', mark, field: property, before })
        }
      } else if (!same(before, moved.value)) {
        mine.push({ type: 'field.set', mark, field: property, before, after: moved.value })
      }

      if (moved.removes !== undefined) {
        const gone = record.fields.get(moved.removes)

        if (gone !== undefined && !mine.some(one => one.type === 'field.remove' && one.field === moved.removes)) {
          mine.push({ type: 'field.remove', mark, field: moved.removes, before: gone })
        }
      }
    }

    // a record with one fault contributes no change at all, so the answer is all or
    // nothing per record as well as per dataset
    if (!bad) {
      changes.push(...mine)
    }
  }

  return { changes, faults }
}
