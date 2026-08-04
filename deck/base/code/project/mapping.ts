// The record-to-table mapping.
//
// A projection's schema is the AUTHOR's, not something the projector invents. The
// author declares two forms and the transformation between them:
//
//   form word        the RECORD shape, what they commit
//   form word_row    the TABLE shape, what the projection stores
//
// This module is that transformation, as data. It says which record form lands in
// which table and which field lands in which column, so the projector can turn a
// field-level change into a column-level write without knowing anything about the
// domain.
//
// See note/library/base/design/projection-schema.md.

import type { RecordNode, Value } from '@term/base/code/base/type'

// A column, and where its value comes from.
export type ColumnMapping = {
  // the column in the author's table
  column: string
  // the field on the record it is taken from
  field: string
}

// One record form projected into one table.
export type TableMapping = {
  // the record form this applies to, matching `RecordNode.type`
  form: string
  // the author's table
  table: string
  // the column holding the record's mark, which is the row's identity. Every mapping
  // needs one: without it a change cannot find the row it belongs to.
  markColumn: string
  columns: Array<ColumnMapping>
}

// Everything a repository projects.
export type Mapping = {
  tables: Array<TableMapping>
}

/** The mapping for a record form, or nothing if the form is not projected. */
export function tableFor(
  mapping: Mapping,
  form: string,
): TableMapping | undefined {
  return mapping.tables.find(table => table.form === form)
}

/** The column a field lands in, or nothing if the field is not projected. */
export function columnFor(
  table: TableMapping,
  field: string,
): string | undefined {
  return table.columns.find(column => column.field === field)?.column
}

/**
 * A record as the columns it projects into.
 *
 * Fields the mapping does not name are DROPPED, deliberately. A projection is a view
 * shaped for reading, not a copy: an author who wants a field queryable says so by
 * giving it a column, and the repository remains the place nothing is lost.
 */
export function rowOf(
  table: TableMapping,
  record: RecordNode,
): Map<string, Value | undefined> {
  const row = new Map<string, Value | undefined>()

  for (const column of table.columns) {
    row.set(column.column, record.fields.get(column.field))
  }

  return row
}
