/**
 * Lifting ordinary data into base records.
 *
 * `from-term.ts` lifts compiled term-lang declarations. This lifts everything else: a CSV
 * of words, a JSON export, a dump of rows. It is the on-ramp, and without it the only way
 * into a repository is to hand-write `.tree` files or to write TypeScript.
 *
 * PURE. It parses strings and builds records, and it reads no files and touches no
 * repository. The CLI does the IO, which keeps every rule below testable without a disk.
 *
 * THE MARK IS THE WHOLE PROBLEM, and it is why this is more than a parser. Every record
 * needs a durable identity that is a uuid version 4, and a CSV of words has no such column.
 * Minting a fresh one per row would make a second import of the same file create a second
 * copy of every record, silently, which is the one failure a data pipeline must not have.
 *
 * So a caller says which of two things is true, and there is no third option:
 *
 *   the row ALREADY CARRIES a mark, in a named column, and it is checked
 *   a named column is a NATURAL KEY, and the mark is found-or-created against it
 *
 * Find-or-create is what makes a re-import an update rather than a duplication. It is the
 * same reconciliation `from-term.ts` takes as `resolveMark`, done here against the records
 * already in the repository.
 *
 * A stable mark is NEVER derived from the key by hashing. That would be a uuid version 5,
 * and a v5 mark leaks its input: anyone holding the mark can confirm a guess at the key.
 * See note/library/base/design/identity-lifecycle.md.
 */

import { valueOf } from '@term/base/code/base/make'
import { isMark, mintMark } from '@term/base/code/base/mark'
import type { Mark, RecordNode, Value } from '@term/base/code/base/type'
import type { Dataset } from '@term/base/code/diff/change'

/** One row of a source, before it becomes a record. */
export type Row = Record<string, unknown>

/**
 * Where a row's mark comes from.
 *
 * `column` when the source already carries one. `key` when a column identifies the row in
 * the source's own terms and the mark is reconciled against it.
 */
export type MarkSource =
  | { kind: 'column'; column: string }
  | { kind: 'key'; column: string }

/** A row that could not be turned into a record, with the reason and its position. */
export class BadRow extends Error {
  constructor(
    readonly at: number,
    readonly why: string,
  ) {
    super(`row ${at}: ${why}`)
    this.name = 'BadRow'
  }
}

/**
 * Parse delimited text: a header row, then one record per line.
 *
 * Written here rather than taken as a dependency because the rules that matter are the ones
 * a small parser gets wrong, and each is one line: a quoted field may contain the delimiter,
 * a newline, and an escaped quote written as two quotes. Getting any of those wrong
 * truncates data rather than failing, which is the worst way for an importer to be broken.
 *
 * VALUES ARE TEXT, always. A source of this shape carries no types, and inferring them
 * would turn a postcode into a number and a version into a decimal. A caller who has types
 * has JSON, and `parseJsonRows` keeps them.
 */
export function parseDelimited(input: {
  text: string
  delimiter: string
}): Array<Row> {
  // A byte order mark would otherwise become part of the first column's NAME, so every
  // lookup of that column silently misses.
  const text = input.text.replace(/^﻿/, '')
  const rows: Array<Array<string>> = []

  let field = ''
  let row: Array<string> = []
  let quoted = false
  let index = 0

  const endField = (): void => {
    row.push(field)
    field = ''
  }

  const endRow = (): void => {
    endField()
    rows.push(row)
    row = []
  }

  while (index < text.length) {
    const at = text[index]!

    if (quoted) {
      if (at === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 2
          continue
        }

        quoted = false
        index++
        continue
      }

      field += at
      index++
      continue
    }

    if (at === '"' && field === '') {
      quoted = true
      index++
      continue
    }

    if (at === input.delimiter) {
      endField()
      index++
      continue
    }

    if (at === '\n') {
      endRow()
      index++
      continue
    }

    if (at === '\r') {
      // CRLF and a lone CR both end a line. Keeping the CR would put an invisible
      // character on the end of every last column.
      if (text[index + 1] === '\n') {
        index++
      }

      endRow()
      index++
      continue
    }

    field += at
    index++
  }

  if (field !== '' || row.length) {
    endRow()
  }

  const header = rows.shift()

  if (!header) {
    return []
  }

  return rows
    // a trailing newline leaves one empty row, which is not a record
    .filter(one => one.length > 1 || one[0] !== '')
    .map(one => {
      const out: Row = {}

      header.forEach((name, column) => {
        const value = one[column]

        // An empty cell is ABSENCE, not an empty string. A delimited source cannot tell
        // them apart, and absence is the reading that lets a column be nullable.
        if (value !== undefined && value !== '') {
          out[name] = value
        }
      })

      return out
    })
}

/**
 * Parse JSON rows: an array of objects, one object, or one object per line.
 *
 * All three, because all three are what people have. Line-delimited is detected by the
 * whole text failing to parse while every non-empty line succeeds, which is exact rather
 * than a guess from the file extension.
 */
export function parseJsonRows(text: string): Array<Row> {
  const trimmed = text.replace(/^﻿/, '').trim()

  if (trimmed === '') {
    return []
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown

    if (Array.isArray(parsed)) {
      return parsed.map((one, at) => {
        if (typeof one !== 'object' || one === null || Array.isArray(one)) {
          throw new BadRow(at + 1, 'is not an object, so it has no fields')
        }

        return one as Row
      })
    }

    if (typeof parsed === 'object' && parsed !== null) {
      return [parsed as Row]
    }

    throw new BadRow(1, 'is not an object or an array of objects')
  } catch (error) {
    if (error instanceof BadRow) {
      throw error
    }

    // Not one JSON document. Line-delimited is the only other shape, and every line has to
    // parse: one that does not means the file is neither, and saying which line is what a
    // caller needs.
    const lines = trimmed.split('\n').filter(one => one.trim() !== '')

    return lines.map((line, at) => {
      try {
        const one = JSON.parse(line) as unknown

        if (typeof one !== 'object' || one === null || Array.isArray(one)) {
          throw new BadRow(at + 1, 'is not an object, so it has no fields')
        }

        return one as Row
      } catch (inner) {
        if (inner instanceof BadRow) {
          throw inner
        }

        throw new BadRow(at + 1, 'is not readable json, and neither is the file as a whole')
      }
    })
  }
}

/** Marks already in use for a form, indexed by a natural key's value. */
function indexByKey(input: {
  dataset: Dataset
  form: string
  key: string
}): Map<string, Mark> {
  const out = new Map<string, Mark>()

  for (const [mark, record] of input.dataset) {
    if (record.type !== input.form) {
      continue
    }

    const value = record.fields.get(input.key)

    if (value === undefined) {
      continue
    }

    const text = plain(value)

    if (text !== undefined && !out.has(text)) {
      out.set(text, mark)
    }
  }

  return out
}

/** A value as the text a natural key compares by, or nothing when it is not a scalar. */
function plain(value: Value): string | undefined {
  switch (value.kind) {
    case 'text':
    case 'decimal':
    case 'date':
      return value.value
    case 'integer':
      return value.value.toString()
    case 'boolean':
      return String(value.value)
    default:
      return undefined
  }
}

export type Lifted = {
  records: Array<RecordNode>
  /** rows that matched a record already in the repository, by natural key */
  reused: number
  /** rows that were given a fresh mark */
  minted: number
}

/**
 * Rows as records, with each row's mark resolved.
 *
 * `existing` is the repository's current dataset, used only by `key` to find what is
 * already there. Left out, every row is new, which is right for a first import and wrong
 * for a second, so a caller doing find-or-create has to pass it.
 *
 * `mint` is injected so a test can watch which rows got a fresh mark. It defaults to a
 * uuid version 4, and nothing here derives one from data.
 */
export function recordsFrom(input: {
  rows: ReadonlyArray<Row>
  form: string
  mark: MarkSource
  existing?: Dataset
  mint?: () => Mark
}): Lifted {
  const mint = input.mint ?? mintMark
  const known =
    input.mark.kind === 'key' && input.existing
      ? indexByKey({
          dataset: input.existing,
          form: input.form,
          key: input.mark.column,
        })
      : new Map<string, Mark>()

  // Within one import, two rows sharing a key are the same record. Without this the second
  // would mint its own mark and the two would fight over the same natural key forever.
  const inRun = new Map<string, Mark>()

  const records: Array<RecordNode> = []
  let reused = 0
  let minted = 0

  input.rows.forEach((row, index) => {
    const at = index + 1
    const raw = row[input.mark.column]

    if (raw === undefined || raw === null || raw === '') {
      throw new BadRow(
        at,
        `has no \`${input.mark.column}\`, which is the column the mark comes from`,
      )
    }

    const key = String(raw)
    let mark: Mark

    if (input.mark.kind === 'column') {
      if (!isMark(key.toLowerCase())) {
        throw new BadRow(
          at,
          `\`${input.mark.column}\` is ${key}, which is not a uuid version 4. A mark must be one, ` +
            'so use --key to reconcile this column to a mark instead of using it as one',
        )
      }

      mark = key.toLowerCase()
      minted++
    } else {
      const held = inRun.get(key) ?? known.get(key)

      if (held) {
        mark = held

        if (known.has(key)) {
          reused++
        }
      } else {
        mark = mint()
        minted++
      }

      inRun.set(key, mark)
    }

    const fields = new Map<string, Value>()

    for (const [name, value] of Object.entries(row)) {
      const lifted = valueOf(value)

      if (lifted !== undefined) {
        fields.set(name, lifted)
      }
    }

    records.push({ mark, type: input.form, fields })
  })

  return { records, reused, minted }
}
