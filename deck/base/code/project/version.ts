// The mapping version: which shape of the projection schema a projection was built against.
//
// A mapping is DERIVED by introspecting the target schema and then cached. So a migration
// that adds a column changes the mapping, and until the projector notices, that column is
// SILENTLY NEVER WRITTEN. It exists, it is null on every row, and nothing reports a problem.
// The projection looks current, the watermark is fresh, and one column is quietly empty.
//
// That is the exact "quietly stale" failure the lag contract exists to prevent, arriving
// through a door the lag contract does not watch: the projection really is up to date with
// every commit, it is just projecting them through a mapping that no longer describes the
// schema.
//
// The recovery on record was "after a view migration, restart the worker". A step someone
// has to remember, whose failure is invisible, is not a protocol. Versioning the mapping
// makes the mismatch a fact the projection carries rather than something an operator has to
// know.
//
// See note/library/base/design/projection-sync-protocol.md §9.2.

import { hashBytes } from '@term/base/code/canon/hash'
import type { Mapping } from '@term/base/code/project/mapping'

/**
 * A deterministic version for a mapping's shape.
 *
 * Covers exactly what changes the rows a projection writes: which tables it maps, which
 * column each field lands in, and which column carries the mark. Nothing else, so a
 * cosmetic change to the schema does not read as a mapping change and train people to
 * ignore the signal.
 *
 * Sorted at every level, so two derivations of the same schema agree regardless of the order
 * `information_schema` happened to return rows in. Without that the version would change on
 * its own and every restart would look like a migration.
 */
export function mappingVersion(mapping: Mapping): string {
  const shape = [...mapping.tables]
    .sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0))
    .map(table =>
      [
        table.table,
        table.form,
        table.markColumn,
        [...table.columns]
          .map(column => `${column.field}:${column.column}`)
          .sort()
          .join(','),
      ].join('|'),
    )
    .join('\n')

  return hashBytes(shape)
}

export type MappingChange = {
  // tables the new mapping has that the old one did not
  addedTables: string[]
  // tables the old mapping had that the new one does not
  removedTables: string[]
  // per table, the columns gained and lost
  addedColumns: Array<{ table: string; column: string }>
  removedColumns: Array<{ table: string; column: string }>
}

/**
 * What changed between two mappings.
 *
 * The distinction that matters is ADDED versus REMOVED, because they need different
 * recoveries and have different urgency:
 *
 *   added     the projection is missing data it could hold. Every existing row has a null
 *             in the new column until something backfills it. Recoverable by replaying.
 *   removed   the projection holds a column no record feeds any more, so its values are
 *             frozen at whatever they were. Worse, because the data LOOKS live.
 *
 * A rename shows up as one of each, which is correct: nothing here can tell a rename from a
 * drop plus an add, and guessing would be worse than reporting both.
 */
export function compareMappings(input: {
  before: Mapping
  after: Mapping
}): MappingChange {
  const before = new Map(input.before.tables.map(t => [t.table, t]))
  const after = new Map(input.after.tables.map(t => [t.table, t]))

  const addedTables = [...after.keys()].filter(t => !before.has(t)).sort()
  const removedTables = [...before.keys()].filter(t => !after.has(t)).sort()
  const addedColumns: Array<{ table: string; column: string }> = []
  const removedColumns: Array<{ table: string; column: string }> = []

  for (const [name, was] of before) {
    const now = after.get(name)

    if (!now) {
      continue
    }

    const had = new Set(was.columns.map(c => c.column))
    const has = new Set(now.columns.map(c => c.column))

    for (const column of [...has].filter(c => !had.has(c)).sort()) {
      addedColumns.push({ table: name, column })
    }

    for (const column of [...had].filter(c => !has.has(c)).sort()) {
      removedColumns.push({ table: name, column })
    }
  }

  return { addedTables, removedTables, addedColumns, removedColumns }
}

/** Whether anything about the mapping's shape moved. */
export function changed(change: MappingChange): boolean {
  return (
    change.addedTables.length > 0 ||
    change.removedTables.length > 0 ||
    change.addedColumns.length > 0 ||
    change.removedColumns.length > 0
  )
}

/** A one-line account of a mapping change, for a log line or an alert. */
export function describeChange(change: MappingChange): string {
  const parts: string[] = []

  if (change.addedTables.length) {
    parts.push(`+${change.addedTables.length} tables`)
  }

  if (change.removedTables.length) {
    parts.push(`-${change.removedTables.length} tables`)
  }

  for (const one of change.addedColumns) {
    parts.push(`+${one.table}.${one.column}`)
  }

  for (const one of change.removedColumns) {
    parts.push(`-${one.table}.${one.column}`)
  }

  return parts.length ? parts.join(', ') : 'no change'
}
