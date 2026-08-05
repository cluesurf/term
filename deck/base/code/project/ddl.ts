// Rendering a table form as DDL, per engine.
//
// The projector generates the FIRST migration only. A form describes the target state,
// not how to reach it from the previous one, and the efficient path between two states is
// not derivable from the states alone. Every later migration is the author's, with
// rebuild-from-empty as the fallback that makes a wrong one recoverable.
//
// See note/library/base/design/table-form-vocabulary.md.

import type {
  Column,
  Default,
  Expression,
  TableForm,
} from '@term/base/code/project/table'
import { isSafeIdentifier, validateTableForm } from '@term/base/code/project/table'

export type Dialect = 'postgres' | 'cockroach'

// The two engines spell the same nine types differently. Nothing else in the vocabulary
// differs, which is the point of bounding it to the intersection.
const TYPES: Record<Dialect, Record<string, string>> = {
  postgres: {
    text: 'TEXT',
    integer: 'BIGINT',
    decimal: 'NUMERIC',
    boolean: 'BOOLEAN',
    date: 'DATE',
    timestamp: 'TIMESTAMPTZ',
    uuid: 'UUID',
    bytes: 'BYTEA',
    json: 'JSONB',
  },
  cockroach: {
    text: 'STRING',
    integer: 'INT8',
    decimal: 'DECIMAL',
    boolean: 'BOOL',
    date: 'DATE',
    timestamp: 'TIMESTAMPTZ',
    uuid: 'UUID',
    bytes: 'BYTES',
    json: 'JSONB',
  },
}

/** An identifier, quoted so a column named like a keyword is still legal. */
export function quote(name: string): string {
  if (!isSafeIdentifier(name)) {
    throw new Error(`unsafe identifier: ${name}`)
  }

  return `"${name}"`
}

/** A literal, for the few places DDL cannot take a parameter. */
function literal(value: string | number | boolean): string {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`unsafe numeric literal: ${value}`)
    }
    return String(value)
  }

  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }

  return `'${value.replace(/'/g, "''")}'`
}

function defaultOf(value: Default): string {
  switch (value.kind) {
    case 'now':
      return 'now()'
    case 'uuid':
      return 'gen_random_uuid()'
    case 'literal':
      return literal(value.value)
  }
}

/**
 * A check or partial-index expression.
 *
 * Every leaf is either a quoted identifier or an escaped literal, and the operator set is
 * closed, so an expression cannot carry arbitrary SQL.
 */
export function renderExpression(expression: Expression): string {
  switch (expression.kind) {
    case 'compare':
      return `${quote(expression.column)} ${expression.op} ${literal(expression.value)}`
    case 'in':
      return `${quote(expression.column)} IN (${expression.values.map(literal).join(', ')})`
    case 'between':
      return `${quote(expression.column)} BETWEEN ${literal(expression.low)} AND ${literal(expression.high)}`
    case 'null':
      return `${quote(expression.column)} IS ${expression.negated ? 'NOT ' : ''}NULL`
    case 'and':
      return `(${expression.parts.map(renderExpression).join(' AND ')})`
    case 'or':
      return `(${expression.parts.map(renderExpression).join(' OR ')})`
    case 'not':
      return `NOT (${renderExpression(expression.part)})`
  }
}

function renderColumn(column: Column, dialect: Dialect): string {
  const type = TYPES[dialect][column.type]

  if (!type) {
    throw new Error(`no ${dialect} type for \`${column.type}\``)
  }

  const parts = [quote(column.name), column.array ? `${type}[]` : type]

  if (column.need) {
    parts.push('NOT NULL')
  }

  if (column.default) {
    parts.push(`DEFAULT ${defaultOf(column.default)}`)
  }

  if (column.references) {
    const reference = column.references
    parts.push(
      `REFERENCES ${quote(reference.table)} (${quote(reference.column)})`,
    )

    if (reference.onDelete) {
      parts.push(`ON DELETE ${reference.onDelete.toUpperCase()}`)
    }
  }

  return parts.join(' ')
}

/**
 * The statements that create a table and its indexes, in order.
 *
 * The form is validated first: generating DDL from a form that cannot be right produces
 * a database that cannot be right, and the failure would surface as a confusing engine
 * error rather than as the actual problem.
 */
export function createTable(input: {
  form: TableForm
  dialect: Dialect
}): Array<string> {
  const problems = validateTableForm(input.form)

  if (problems.length) {
    throw new Error(
      `table form \`${input.form.table}\` is not valid:\n  ${problems.join('\n  ')}`,
    )
  }

  const { form, dialect } = input
  const body: Array<string> = form.columns.map(column =>
    renderColumn(column, dialect),
  )

  body.push(`PRIMARY KEY (${quote(form.mark)})`)

  for (const unique of form.unique ?? []) {
    body.push(
      `CONSTRAINT ${quote(unique.name)} UNIQUE (${unique.columns.map(quote).join(', ')})`,
    )
  }

  for (const check of form.checks ?? []) {
    body.push(
      `CONSTRAINT ${quote(check.name)} CHECK (${renderExpression(check.expression)})`,
    )
  }

  const statements = [
    `CREATE TABLE IF NOT EXISTS ${quote(form.table)} (\n  ${body.join(',\n  ')}\n)`,
  ]

  for (const index of form.indexes ?? []) {
    const columns = index.columns.map(quote).join(', ')

    if (index.kind === 'inverted') {
      // CockroachDB calls this an inverted index but accepts `USING GIN`, so one spelling
      // serves both engines.
      statements.push(
        `CREATE INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(form.table)} USING GIN (${columns})`,
      )
      continue
    }

    const unique = index.kind === 'unique' ? 'UNIQUE ' : ''
    const where =
      index.kind === 'partial' && index.where
        ? ` WHERE ${renderExpression(index.where)}`
        : ''

    statements.push(
      `CREATE ${unique}INDEX IF NOT EXISTS ${quote(index.name)} ON ${quote(form.table)} (${columns})${where}`,
    )
  }

  return statements
}

// Where the projector records what it has applied. Kept in the projection itself so a
// projection is self-describing: the serving commit travels with the data it serves, and
// a restored backup cannot disagree with its own bookkeeping.
export const BOOKKEEPING_TABLE = 'base_projection'

export function createBookkeeping(dialect: Dialect): Array<string> {
  const uuid = TYPES[dialect].uuid
  const text = TYPES[dialect].text

  return [
    `CREATE TABLE IF NOT EXISTS ${quote(BOOKKEEPING_TABLE)} (
  "repository" ${uuid} NOT NULL,
  "commit" ${text} NOT NULL,
  "applied" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("repository")
)`,
    `CREATE TABLE IF NOT EXISTS ${quote(`${BOOKKEEPING_TABLE}_log`)} (
  "repository" ${uuid} NOT NULL,
  "commit" ${text} NOT NULL,
  "applied" TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY ("repository", "commit")
)`,
  ]
}
