// Querying a projection, and choosing the declared index that serves it.
//
// An index is a SCHEMA decision (the author declares it on the table form) and the
// projector materializes it. This module closes the loop: it picks which declared index
// answers a query and renders SQL shaped so that index can be used.
//
// The chosen index is REPORTED rather than left to the engine's planner, because a
// declaration that silently fails to help is the failure mode worth catching: an author
// who declares an index wants to know their query uses it.
//
// See note/library/base/design/query-and-indexing.md.

import type { Value } from '@term/base/code/base/type'
import { quote } from '@term/base/code/project/ddl'
import { toParam, type Statement } from '@term/base/code/project/sql'
import type { Expression, Index, TableForm } from '@term/base/code/project/table'

export type Compare = '=' | '<' | '<=' | '>' | '>='

export type Condition =
  | { column: string; op: Compare; value: Value }
  | { column: string; op: 'in'; values: Array<Value> }

export type Order = { column: string; direction: 'ascending' | 'descending' }

export type Query = {
  where?: Array<Condition>
  order?: Order
  limit?: number
  offset?: number
}

// Which index was chosen, and why. `undefined` means a full scan, which is a legitimate
// answer for a small table and a bad surprise on a large one, so it is reported either
// way rather than hidden.
export type Plan = {
  index?: string
  // the leading index columns matched by equality, which is what makes a B-tree useful
  matched: Array<string>
  // present when no index was chosen, so the reason is legible rather than guessed at
  scan?: 'no-index-matches' | 'no-conditions'
}

const EQUALITY: Array<string> = ['=', 'in']

function columnsOf(query: Query): Map<string, Condition> {
  const out = new Map<string, Condition>()

  for (const condition of query.where ?? []) {
    const existing = out.get(condition.column)

    // An EQUALITY on a column wins over a range on the same column, because equality is
    // what extends an index prefix. Keeping whichever came first would let
    // `syllables > 1 AND syllables = 3` plan as a range and miss the usable index.
    if (!existing || (!EQUALITY.includes(existing.op) && EQUALITY.includes(condition.op))) {
      out.set(condition.column, condition)
    }
  }

  return out
}

/**
 * Is a partial index usable for this query?
 *
 * Only when the query states the index's own condition, compared structurally. Proving
 * that one predicate IMPLIES another is a decision problem in general, and a wrong
 * answer here means silently reading a partial index that omits matching rows. So the
 * check is deliberately narrow: an exact match, or nothing.
 */
function partialApplies(index: Index, query: Query): boolean {
  if (!index.where) {
    return true
  }

  return (query.where ?? []).some(condition =>
    sameCondition(index.where!, condition),
  )
}

function sameCondition(expression: Expression, condition: Condition): boolean {
  if (expression.kind === 'compare' && condition.op !== 'in') {
    return (
      expression.column === condition.column &&
      expression.op === condition.op &&
      literalOf(condition.value) === expression.value
    )
  }

  return false
}

const SAFE_LOW = BigInt(Number.MIN_SAFE_INTEGER)
const SAFE_HIGH = BigInt(Number.MAX_SAFE_INTEGER)

function literalOf(value: Value): string | number | boolean | undefined {
  switch (value.kind) {
    case 'text':
      return value.value
    case 'integer':
      // A bigint past the exact double range cannot be compared to a declared numeric
      // literal without rounding, and rounding could make two different values look
      // equal. That would select a partial index whose condition the query does NOT
      // actually state, which is the one thing partial-index matching must never do.
      // No match is always safe; a wrong match silently omits rows.
      return value.value >= SAFE_LOW && value.value <= SAFE_HIGH
        ? Number(value.value)
        : undefined
    case 'decimal':
      return value.value
    case 'boolean':
      return value.value
    default:
      return undefined
  }
}

/**
 * The declared index that best serves a query.
 *
 * B-tree prefix rule: an index helps when the query fixes its LEADING columns by
 * equality. `(a, b)` serves `a = 1 AND b = 2` and `a = 1`, but not `b = 2` alone, which
 * is why the match is counted from the front and stops at the first gap.
 *
 * Ties break toward the longer prefix, then toward a unique index, since a unique match
 * reads at most one row.
 */
export function planQuery(form: TableForm, query: Query): Plan {
  const conditions = columnsOf(query)

  if (conditions.size === 0) {
    // an ordered read with no filter is still served by an index on the sort column
    const ordered = (form.indexes ?? []).find(
      index =>
        index.kind !== 'inverted' &&
        !index.where &&
        index.columns[0] === query.order?.column,
    )

    return ordered
      ? { index: ordered.name, matched: [] }
      : { matched: [], scan: 'no-conditions' }
  }

  let best: Plan | undefined
  let bestIndex: Index | undefined

  for (const index of form.indexes ?? []) {
    // an inverted index answers containment, which this query vocabulary cannot express
    if (index.kind === 'inverted' || !partialApplies(index, query)) {
      continue
    }

    const matched: Array<string> = []

    for (const column of index.columns) {
      const condition = conditions.get(column)

      if (!condition || !EQUALITY.includes(condition.op)) {
        // a range on the column just past the equality prefix still uses the index, but
        // it ends the prefix
        break
      }

      matched.push(column)
    }

    if (matched.length === 0) {
      continue
    }

    const better =
      !best ||
      matched.length > best.matched.length ||
      (matched.length === best.matched.length &&
        index.kind === 'unique' &&
        bestIndex?.kind !== 'unique')

    if (better) {
      best = { index: index.name, matched }
      bestIndex = index
    }
  }

  return best ?? { matched: [], scan: 'no-index-matches' }
}

/**
 * Every column a query names that the form does not declare.
 *
 * A typo would otherwise render valid SQL and fail at the engine with an error naming
 * the column but not the query, which is a long way from the mistake.
 */
export function unknownColumns(form: TableForm, query: Query, columns?: Array<string>): Array<string> {
  const declared = new Set(form.columns.map(column => column.name))
  const named = [
    ...(query.where ?? []).map(condition => condition.column),
    ...(query.order ? [query.order.column] : []),
    ...(columns ?? []),
  ]

  return [...new Set(named.filter(column => !declared.has(column)))]
}

/** A query as a parameterized statement, with the columns to select. */
export function toSelect(input: {
  form: TableForm
  query: Query
  columns?: Array<string>
}): Statement {
  const { form, query } = input
  const unknown = unknownColumns(form, query, input.columns)

  if (unknown.length) {
    throw new Error(
      `table \`${form.table}\` has no column ${unknown.map(name => `\`${name}\``).join(', ')}`,
    )
  }

  const columns = input.columns?.length
    ? input.columns.map(quote).join(', ')
    : '*'

  const params: Array<unknown> = []
  const clauses: Array<string> = []

  for (const condition of query.where ?? []) {
    if (condition.op === 'in') {
      if (condition.values.length === 0) {
        // an empty `IN` matches nothing; say so explicitly rather than emitting `IN ()`,
        // which is a syntax error in both engines
        clauses.push('FALSE')
        continue
      }

      const places = condition.values.map(value => {
        params.push(toParam(value))

        return `$${params.length}`
      })

      clauses.push(`${quote(condition.column)} IN (${places.join(', ')})`)
      continue
    }

    params.push(toParam(condition.value))
    clauses.push(`${quote(condition.column)} ${condition.op} $${params.length}`)
  }

  const parts = [`SELECT ${columns} FROM ${quote(form.table)}`]

  if (clauses.length) {
    parts.push(`WHERE ${clauses.join(' AND ')}`)
  }

  if (query.order) {
    const direction = query.order.direction === 'descending' ? 'DESC' : 'ASC'
    parts.push(`ORDER BY ${quote(query.order.column)} ${direction}`)
  }

  if (query.limit !== undefined) {
    params.push(query.limit)
    parts.push(`LIMIT $${params.length}`)
  }

  if (query.offset !== undefined) {
    params.push(query.offset)
    parts.push(`OFFSET $${params.length}`)
  }

  return { sql: parts.join(' '), params }
}
