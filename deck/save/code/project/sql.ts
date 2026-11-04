// Rendering a row write as a parameterized statement.
//
// Every value travels as a parameter, never interpolated, so record content cannot reach
// the engine as SQL. Both Postgres and CockroachDB use `$1` placeholders, so one renderer
// serves both.
//
// See note/project/base/design/projection-schema.md.

import type { Value } from '@cluesurf/save/base/type'
import { lowerJson } from '@cluesurf/save/bridge/json'
import { quote } from '@cluesurf/save/project/ddl'
import type { Write } from '@cluesurf/save/project/write'

export type Statement = { sql: string; params: Array<unknown> }

/**
 * A record value as an engine parameter.
 *
 * `integer` is a bigint, which no driver accepts uniformly, so it becomes a string and
 * the column's own type does the conversion. That keeps a 64-bit value exact, which a
 * number would not.
 */
export function toParam(value: Value | undefined, asArray = false): unknown {
  if (value === undefined) {
    return null
  }

  // An ARRAY column takes a JS array, which every driver renders as a Postgres array. A
  // collection bound for one must NOT be stringified: `'[0,0,5]'` is a valid json value and
  // an invalid `int2[]`, so the two forms fail in opposite directions and neither failure
  // mentions the other.
  if (asArray && value.kind === 'collection') {
    return value.items.map(item => toParam(item.value))
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
      // a container has no column type of its own, so it lands in a `json` column, as
      // the JSON it was lifted from. Until 2026-09-07 this wrote `{ type, ...fields }`
      // and integers as strings, and a page body came back out of the projection as
      // something the page's own checker refused. `lowerJson` is the inverse of the
      // lifter, and the law between them is a test.
      return JSON.stringify(lowerJson(value))
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
      const params = [
        write.mark,
        ...[...write.values.entries()].map(([column, value]) =>
          toParam(value, write.arrays?.has(column) === true),
        ),
      ]
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
        ...[...write.values.entries()].map(([column, value]) =>
          toParam(value, write.arrays?.has(column) === true),
        ),
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
