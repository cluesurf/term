// Rendering a row write as a parameterized statement.
//
// Every value travels as a parameter, never interpolated, so record content cannot reach
// the engine as SQL. Both Postgres and CockroachDB use `$1` placeholders, so one renderer
// serves both.
//
// See note/library/base/design/projection-schema.md.

import type { Value } from '@term/base/code/base/type'
import { quote } from '@term/base/code/project/ddl'
import type { Write } from '@term/base/code/project/write'

export type Statement = { sql: string; params: Array<unknown> }

/**
 * A record value as an engine parameter.
 *
 * `integer` is a bigint, which no driver accepts uniformly, so it becomes a string and
 * the column's own type does the conversion. That keeps a 64-bit value exact, which a
 * number would not.
 */
export function toParam(value: Value | undefined): unknown {
  if (value === undefined) {
    return null
  }

  switch (value.kind) {
    case 'text':
      return value.value
    case 'integer':
      return value.value.toString()
    case 'decimal':
      return value.value
    case 'boolean':
      return value.value
    case 'date':
      return value.value
    case 'null':
      return null
    case 'ref':
      return value.target
    case 'blob':
      return value.hash
    case 'collection':
    case 'record':
      // a container has no column type of its own, so it lands in a `json` column
      return JSON.stringify(toPlain(value))
  }
}

/** A value as plain data, for a json column. */
function toPlain(value: Value): unknown {
  switch (value.kind) {
    case 'integer':
      return value.value.toString()
    case 'null':
      return null
    case 'ref':
      return { ref: value.target }
    case 'blob':
      return { blob: value.hash }
    case 'collection':
      return value.items.map(item =>
        item.key === undefined
          ? toPlain(item.value)
          : { key: item.key, value: toPlain(item.value) },
      )
    case 'record': {
      const out: Record<string, unknown> = { type: value.record.type }

      for (const [field, inner] of value.record.fields) {
        out[field] = toPlain(inner)
      }

      return out
    }
    default:
      return value.value
  }
}

/**
 * A write as a statement.
 *
 * An insert is rendered as an upsert. A projection is derived state that may be applied
 * more than once (a retry, a replay, a rebuild that overlaps existing rows), so a write
 * that fails on a row already present would make replay unsafe.
 */
export function toStatement(write: Write): Statement {
  switch (write.type) {
    case 'insert': {
      const columns = [write.markColumn, ...write.values.keys()]
      const params = [write.mark, ...[...write.values.values()].map(toParam)]
      const places = columns.map((_, i) => `$${i + 1}`)
      const updates = [...write.values.keys()].map(
        column => `${quote(column)} = EXCLUDED.${quote(column)}`,
      )

      const conflict = updates.length
        ? `DO UPDATE SET ${updates.join(', ')}`
        : 'DO NOTHING'

      return {
        sql: `INSERT INTO ${quote(write.table)} (${columns.map(quote).join(', ')}) VALUES (${places.join(', ')}) ON CONFLICT (${quote(write.markColumn)}) ${conflict}`,
        params,
      }
    }

    case 'update': {
      const columns = [...write.values.keys()]
      const sets = columns.map((column, i) => `${quote(column)} = $${i + 1}`)
      const params = [
        ...[...write.values.values()].map(toParam),
        write.mark,
      ]

      return {
        sql: `UPDATE ${quote(write.table)} SET ${sets.join(', ')} WHERE ${quote(write.markColumn)} = $${columns.length + 1}`,
        params,
      }
    }

    case 'delete':
      return {
        sql: `DELETE FROM ${quote(write.table)} WHERE ${quote(write.markColumn)} = $1`,
        params: [write.mark],
      }
  }
}
