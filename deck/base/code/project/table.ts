// The table form: what an author may declare about a projection's schema.
//
// Bounded by what BOTH Postgres and CockroachDB support, so a form written for one runs
// unchanged on the other. This is a deliberate restriction: supporting the union would
// mean a form that silently fails to port, which defeats the reason a form exists instead
// of raw DDL.
//
// See note/library/base/design/table-form-vocabulary.md.

// Nine column types, each mapping from a record `Like` with no ambiguity either way.
export type ColumnType =
  | 'text'
  | 'integer'
  | 'decimal'
  | 'boolean'
  | 'date'
  | 'timestamp'
  | 'uuid'
  | 'bytes'
  | 'json'

export const COLUMN_TYPES: ReadonlyArray<ColumnType> = [
  'text',
  'integer',
  'decimal',
  'boolean',
  'date',
  'timestamp',
  'uuid',
  'bytes',
  'json',
]

// What a `DEFAULT` may be. Restricted to values that mean the same thing in both engines.
export type Default =
  | { kind: 'literal'; value: string | number | boolean }
  | { kind: 'now' }
  | { kind: 'uuid' }

// What happens to a referencing row when its target is deleted.
export type OnDelete = 'cascade' | 'restrict' | 'set null'

export type Reference = {
  table: string
  column: string
  onDelete?: OnDelete
}

export type Column = {
  name: string
  type: ColumnType
  // an array of `type`, which is not allowed for `json` since it is already a container
  array?: boolean
  need?: boolean
  default?: Default
  references?: Reference
}

// The closed check-expression set. No function calls, so a check cannot depend on
// anything version-specific.
export type Compare = '=' | '<>' | '<' | '<=' | '>' | '>='

export type Expression =
  | { kind: 'compare'; op: Compare; column: string; value: string | number | boolean }
  | { kind: 'in'; column: string; values: Array<string | number | boolean> }
  | { kind: 'between'; column: string; low: string | number; high: string | number }
  | { kind: 'null'; column: string; negated?: boolean }
  | { kind: 'and'; parts: Array<Expression> }
  | { kind: 'or'; parts: Array<Expression> }
  | { kind: 'not'; part: Expression }

export type Check = { name: string; expression: Expression }

// Four index kinds. The author never names an index method: `btree` is the only ordered
// method both engines offer, so naming it would add a word that can only take one value.
export type Index = {
  name: string
  columns: Array<string>
  kind: 'plain' | 'unique' | 'partial' | 'inverted'
  // partial only
  where?: Expression
}

// A legal SQL identifier in both engines, unquoted-safe. Anything else is rejected at
// declaration rather than at DDL time, so a bad name is a form error with a form's
// context, not a render error deep in a statement.
const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/i

export function isSafeIdentifier(name: string): boolean {
  return SAFE_IDENTIFIER.test(name)
}

export type TableForm = {
  table: string
  // the primary key column, always a uuid, because a row's identity is the record's mark
  mark: string
  columns: Array<Column>
  // unique constraints over one or several columns
  unique?: Array<{ name: string; columns: Array<string> }>
  checks?: Array<Check>
  indexes?: Array<Index>
}

/**
 * Everything wrong with a table form, as messages.
 *
 * Reported all at once rather than throwing on the first, so an author fixes a form in
 * one pass instead of one error per attempt.
 */
export function validateTableForm(form: TableForm): Array<string> {
  const problems: Array<string> = []
  const names = new Set<string>()

  if (!form.table) {
    problems.push('a table form needs a table name')
  } else if (!isSafeIdentifier(form.table)) {
    problems.push(`table name \`${form.table}\` is not a legal identifier`)
  }

  for (const column of form.columns) {
    if (names.has(column.name)) {
      problems.push(`duplicate column \`${column.name}\``)
    }
    names.add(column.name)

    if (!isSafeIdentifier(column.name)) {
      problems.push(`column name \`${column.name}\` is not a legal identifier`)
    }

    if (!COLUMN_TYPES.includes(column.type)) {
      problems.push(
        `column \`${column.name}\` has type \`${column.type}\`, which is not in the portable set`,
      )
    }

    if (column.array && column.type === 'json') {
      problems.push(
        `column \`${column.name}\` is an array of json, which is already a container`,
      )
    }
  }

  const mark = form.columns.find(column => column.name === form.mark)

  if (!mark) {
    problems.push(`the mark column \`${form.mark}\` is not among the columns`)
  } else if (mark.type !== 'uuid') {
    problems.push(
      `the mark column \`${form.mark}\` is \`${mark.type}\`, but a row's identity is a record's mark and must be uuid`,
    )
  } else if (mark.array) {
    problems.push(`the mark column \`${form.mark}\` cannot be an array`)
  }

  for (const index of form.indexes ?? []) {
    if (!isSafeIdentifier(index.name)) {
      problems.push(`index name \`${index.name}\` is not a legal identifier`)
    }

    for (const column of index.columns) {
      if (!names.has(column)) {
        problems.push(`index \`${index.name}\` names unknown column \`${column}\``)
      }
    }

    if (index.kind === 'partial' && !index.where) {
      problems.push(`partial index \`${index.name}\` needs a \`where\``)
    }

    if (index.kind !== 'partial' && index.where) {
      problems.push(`index \`${index.name}\` has a \`where\` but is not partial`)
    }

    if (index.kind === 'inverted') {
      const target = form.columns.find(c => c.name === index.columns[0])

      if (index.columns.length !== 1) {
        problems.push(`inverted index \`${index.name}\` covers exactly one column`)
      } else if (target && target.type !== 'json' && !target.array) {
        problems.push(
          `inverted index \`${index.name}\` needs a json or array column, but \`${target.name}\` is \`${target.type}\``,
        )
      }
    }
  }

  for (const unique of form.unique ?? []) {
    for (const column of unique.columns) {
      if (!names.has(column)) {
        problems.push(`unique \`${unique.name}\` names unknown column \`${column}\``)
      }
    }
  }

  for (const column of form.columns) {
    if (column.references && column.array) {
      problems.push(
        `column \`${column.name}\` is an array and cannot carry a foreign key`,
      )
    }
  }

  return problems
}
