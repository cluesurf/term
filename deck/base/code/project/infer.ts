/**
 * Working out a projection's schema from the records themselves.
 *
 * `mapping.ts` says what a mapping IS. Deriving one normally means introspecting a database
 * that already has the tables, which is right when adopting an existing schema and useless
 * for the case this exists for: somebody holds a repository and wants its contents in a
 * fresh database. There is no schema to read, and asking them to hand-write a mapping is
 * the difference between a system with an on-ramp and one without.
 *
 * So the records are the schema. A form becomes a table, a field becomes a column, and a
 * value's kind becomes a column type.
 *
 * THREE RULES THAT ARE NOT OBVIOUS, and each exists because the naive version loses
 * something quietly.
 *
 * A field that is ABSENT from some records is nullable, and one present on every record of
 * its form is `NOT NULL`. That is real information the records carry and a projection that
 * made everything nullable would throw it away.
 *
 * `null` VALUES DO NOT VOTE on a field's type. A null says the field is empty, not what it
 * would hold, so inferring from it would make the first empty row decide the column. A
 * field that is null everywhere has nothing to go on and becomes text.
 *
 * A FIELD WITH TWO KINDS IS REFUSED, by name, with both kinds. Widening to text would let
 * a source with an integer in one row and a word in another produce a table that no longer
 * knows which, and the mistake would surface as a query returning nothing much later. The
 * data is wrong, or the intent is text and saying so is one line.
 *
 * See note/library/base/design/projection-schema.md.
 */

import type { Dataset } from '@term/base/code/diff/change'
import type { Value } from '@term/base/code/base/type'
import type { Mapping, TableMapping } from '@term/base/code/project/mapping'
import type { Column, ColumnType, TableForm } from '@term/base/code/project/table'

/** The column a record's mark lands in, when the caller does not say. */
export const DEFAULT_MARK_COLUMN = 'mark'

export type Inferred = {
  mapping: Mapping
  forms: Array<TableForm>
}

/** A field that could not be given one type, with the kinds that disagreed. */
export class MixedField extends Error {
  constructor(
    readonly form: string,
    readonly field: string,
    readonly kinds: Array<string>,
  ) {
    super(
      `${form}.${field} holds ${kinds.join(' and ')} in different records, so it has no single column type. ` +
        'Make the source consistent, or write a mapping that says which it is.',
    )
    this.name = 'MixedField'
  }
}

/**
 * The column type a value's kind projects into.
 *
 * `ref` is a uuid because a reference is another record's mark. `blob` is text because the
 * column holds the content address rather than the bytes. A `record` is json because a
 * nested shape has no column of its own, which is the same rule the statement builder
 * follows, so the two cannot disagree about where a nested value goes.
 */
function typeOf(value: Value): ColumnType | undefined {
  switch (value.kind) {
    case 'text':
      return 'text'
    case 'integer':
      return 'integer'
    case 'decimal':
      return 'decimal'
    case 'boolean':
      return 'boolean'
    case 'date':
      return 'date'
    case 'ref':
      return 'uuid'
    case 'blob':
      return 'text'
    case 'record':
      return 'json'
    case 'collection':
      // an array of the element type, when the elements agree. The element decides, so an
      // empty collection says nothing and is left for another record to settle.
      return undefined
    case 'null':
      // deliberately no vote: see the header
      return undefined
  }
}

/** The column type an array column's ELEMENTS take, when a collection's elements agree. */
function elementTypeOf(value: Value): ColumnType | undefined {
  if (value.kind !== 'collection') {
    return undefined
  }

  const kinds = new Set<ColumnType>()

  for (const item of value.items) {
    const type = typeOf(item.value)

    if (type !== undefined) {
      kinds.add(type)
    }
  }

  return kinds.size === 1 ? [...kinds][0] : undefined
}

type Seen = {
  type?: ColumnType
  array: boolean
  /** the kinds observed, for the message when they disagree */
  kinds: Set<string>
  /** records of this form that carried the field */
  present: number
}

/**
 * A mapping and the table forms for a dataset.
 *
 * Deterministic: forms and their columns come out sorted, so two runs over the same records
 * produce the same schema and a mapping can be compared or committed.
 */
export function inferProjection(input: {
  dataset: Dataset
  markColumn?: string
}): Inferred {
  const markColumn = input.markColumn ?? DEFAULT_MARK_COLUMN
  const counts = new Map<string, number>()
  const fields = new Map<string, Map<string, Seen>>()

  for (const record of input.dataset.values()) {
    counts.set(record.type, (counts.get(record.type) ?? 0) + 1)

    const seen = fields.get(record.type) ?? new Map<string, Seen>()

    fields.set(record.type, seen)

    for (const [name, value] of record.fields) {
      if (name === markColumn) {
        // The mark is the row's identity and is written from the record's mark, never from
        // a field of the same name. Letting a field claim it would let a record overwrite
        // which row it is.
        continue
      }

      const held = seen.get(name) ?? {
        array: false,
        kinds: new Set<string>(),
        present: 0,
      }

      held.present++
      held.kinds.add(value.kind)

      const type =
        value.kind === 'collection' ? elementTypeOf(value) : typeOf(value)

      if (value.kind === 'collection') {
        held.array = true
      }

      if (type !== undefined) {
        if (held.type !== undefined && held.type !== type) {
          throw new MixedField(record.type, name, [held.type, type])
        }

        held.type = type
      }

      seen.set(name, held)
    }
  }

  const tables: Array<TableMapping> = []
  const forms: Array<TableForm> = []

  for (const form of [...counts.keys()].sort()) {
    const seen = fields.get(form) ?? new Map<string, Seen>()
    const names = [...seen.keys()].sort()
    const total = counts.get(form)!

    tables.push({
      form,
      table: form,
      markColumn,
      columns: names.map(name => ({
        column: name,
        field: name,
        ...(seen.get(name)!.array ? { array: true } : {}),
      })),
    })

    forms.push({
      table: form,
      mark: markColumn,
      columns: [
        { name: markColumn, type: 'uuid', need: true },
        ...names.map((name): Column => {
          const held = seen.get(name)!

          return {
            name,
            // A field that is null in every record it appears in has nothing to go on, so
            // it becomes text rather than blocking the whole import on one empty column.
            type: held.type ?? 'text',
            ...(held.array ? { array: true } : {}),
            ...(held.present === total ? { need: true } : {}),
          }
        }),
      ],
      indexes: [],
    })
  }

  return { mapping: { tables }, forms }
}
