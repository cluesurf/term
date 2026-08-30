/**
 * `term base import`: getting ordinary data in.
 *
 * The on-ramp. Everything else in `term base` assumes records already exist, and until this
 * the only two ways to make them were hand-writing `.tree` files or writing TypeScript,
 * which is the difference between a system somebody else can use and one only its author
 * can.
 *
 * Point it at a file or a directory. A CSV of words, a JSON export, a directory of both.
 *
 *   term base import words.csv --form word --key slug
 *   term base import rows.jsonl --form word --mark id
 *   term base import ./data --form word --key slug
 *
 * THE PARSING AND THE LIFTING ARE NOT HERE. They are `@term/base/code/bridge/from-data`,
 * pure and tested without a disk. This file is the IO and the wiring, which is the same
 * split every other verb follows, so a bug here is a file-reading bug.
 *
 * A RE-IMPORT UPDATES RATHER THAN DUPLICATES, which is the whole reason `--key` exists.
 * The records already in the branch are read first, and a row whose key is already there
 * keeps its mark. Running the same file twice is a no-op, and running a corrected file
 * changes only what changed.
 *
 * It commits by CHANGES rather than by replacing the branch's dataset, so importing one
 * form leaves every other form alone. Replacing would silently empty them.
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  BadRow,
  parseDelimited,
  parseJsonRows,
  recordsFrom,
  type Row,
} from '@term/base/code/bridge/from-data'
import { diffDataset } from '@term/base/code/diff/diff'
import { need } from './base'
import type { Dataset } from '@term/base/code/diff/change'

// What a source's extension says it is. A directory is walked for these and nothing else,
// so a readme or a licence beside the data is skipped rather than failing the run.
const DELIMITED: Record<string, string> = {
  '.csv': ',',
  '.tsv': '\t',
}

const JSON_LIKE = new Set(['.json', '.jsonl', '.ndjson'])

/** Every data file a source names: the file itself, or the ones inside a directory. */
function sourceFiles(source: string): Array<string> {
  if (!fs.existsSync(source)) {
    console.error(`no file or directory at ${source}`)
    process.exit(1)
  }

  if (!fs.statSync(source).isDirectory()) {
    return [source]
  }

  // Sorted, so importing a directory twice produces the same marks in the same order and
  // two runs can be compared.
  const found = fs
    .readdirSync(source)
    .sort()
    .map(name => path.join(source, name))
    .filter(one => {
      const extension = path.extname(one).toLowerCase()

      return (
        fs.statSync(one).isFile() &&
        (extension in DELIMITED || JSON_LIKE.has(extension))
      )
    })

  if (!found.length) {
    console.error(
      `no .csv, .tsv, .json, .jsonl or .ndjson files in ${source}. ` +
        'A directory is walked for those and nothing else.',
    )
    process.exit(1)
  }

  return found
}

/** One file's rows, by its extension. */
function rowsOf(file: string): Array<Row> {
  const extension = path.extname(file).toLowerCase()
  const text = fs.readFileSync(file, 'utf8')
  const delimiter = DELIMITED[extension]

  if (delimiter !== undefined) {
    return parseDelimited({ text, delimiter })
  }

  return parseJsonRows(text)
}

export function callBaseImport(input: {
  root: string
  source: string
  form: string
  key?: string
  mark?: string
  branch: string
  author: string
  message?: string
}): void {
  if ((input.key === undefined) === (input.mark === undefined)) {
    // Neither, or both. Without one of them every row would get a fresh mark and a second
    // import would duplicate every record silently, which is the one failure a data
    // pipeline must not have.
    console.error(
      'say where the mark comes from, with exactly one of:\n' +
        '  --key <column>   the column identifies a row in the source. The mark is found or created against it, so a re-import updates\n' +
        '  --mark <column>  the column already holds a uuid version 4, and it is used as the mark',
    )
    process.exit(1)
  }

  const { repo, save } = need(input.root)
  const files = sourceFiles(input.source)

  const rows: Array<Row> = []

  for (const file of files) {
    try {
      const found = rowsOf(file)

      rows.push(...found)
      console.log(`${path.basename(file)}: ${found.length} row(s)`)
    } catch (error) {
      console.error(
        `${file}: ${error instanceof Error ? error.message : String(error)}`,
      )
      process.exit(1)
    }
  }

  if (!rows.length) {
    console.log('nothing to import')

    return
  }

  const head = repo.head(input.branch)
  const existing: Dataset = head ? repo.checkout(head) : new Map()

  let lifted

  try {
    lifted = recordsFrom({
      rows,
      form: input.form,
      mark:
        input.key === undefined
          ? { kind: 'column', column: input.mark! }
          : { kind: 'key', column: input.key },
      existing,
    })
  } catch (error) {
    console.error(
      error instanceof BadRow
        ? error.message
        : `could not lift the rows: ${error instanceof Error ? error.message : String(error)}`,
    )
    process.exit(1)
  }

  // Applied ON TOP of what is there, so importing one form leaves every other form alone.
  // Committing the imported records as the whole dataset would empty the others.
  const next: Dataset = new Map(existing)

  for (const record of lifted.records) {
    next.set(record.mark!, record)
  }

  const changes = diffDataset(existing, next)

  if (!changes.length) {
    console.log(
      `\n${rows.length} row(s), nothing changed. Every record is already what the source says.`,
    )

    return
  }

  const done = repo.commit(
    input.branch,
    {
      author: input.author,
      time: Date.now(),
      message:
        input.message ??
        `import ${lifted.records.length} ${input.form} record(s) from ${path.basename(input.source)}`,
    },
    next,
  )

  if (!done.ok) {
    console.error('refused:')

    for (const one of done.diagnostics ?? []) {
      console.error(`  ${one.mark ?? '(dataset)'}  ${one.message}`)
    }

    process.exit(1)
  }

  save()

  console.log(`\n${done.commit}`)
  console.log(
    `${lifted.records.length} ${input.form} record(s): ` +
      `${lifted.minted} new, ${lifted.reused} matched by \`${input.key ?? input.mark}\``,
  )
  console.log(`${changes.length} change(s) on ${input.branch}`)
}
