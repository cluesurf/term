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
 * THE PARSING AND THE LIFTING ARE NOT HERE. They are `@cluesurf/save/bridge/from-data`,
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
} from '@cluesurf/save/bridge/from-data'
import { diffDataset } from '@cluesurf/save/diff/diff'
import { need, refuse } from './base'
import type { Dataset } from '@cluesurf/save/diff/change'
import { closeRun, count, field, openRun, printData, report } from '@term/call/code/output'

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
    refuse(`There is no file or directory at ${source}`)
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
    refuse(`There is no .csv, .tsv, .json, .jsonl or .ndjson file in ${source}`, {
      message: ['A directory is walked for those and nothing else.'],
    })
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
  openRun({ verb: 'import', root: input.root, subject: input.source, facts: [input.form, input.branch] })

  if ((input.key === undefined) === (input.mark === undefined)) {
    // Neither, or both. Without one of them every row would get a fresh mark and a second
    // import would duplicate every record silently, which is the one failure a data
    // pipeline must not have.
    refuse('Say where the mark comes from, with exactly one of --key and --mark', {
      // a flag the command line owed: wrong usage, exit 2 (section 18)
      failure: 'usage',
      fields: [
        field('--key', 'the column identifies a row in the source; the mark is found or created against it, so a re-import updates'),
        field('--mark', 'the column already holds a uuid version 4, and it is used as the mark'),
      ],
      verdict: 'The command line was not understood',
    })
  }

  const { repo, save } = need(input.root)
  const files = sourceFiles(input.source)

  const rows: Array<Row> = []

  for (const file of files) {
    try {
      const found = rowsOf(file)

      rows.push(...found)
      report({ glyph: 'done', verb: 'read', subject: path.basename(file), counts: [count(found.length, 'rows', 'row')] })
    } catch (error) {
      refuse(error instanceof Error ? error.message : String(error), { fields: [{ ...field('at', file), location: true }] })
    }
  }

  if (!rows.length) {
    closeRun({ verdict: 'Nothing to import', counts: [count(0, 'rows', 'row')] })

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
    refuse(
      error instanceof BadRow
        ? error.message
        : `Could not lift the rows: ${error instanceof Error ? error.message : String(error)}`,
    )
  }

  // Applied ON TOP of what is there, so importing one form leaves every other form alone.
  // Committing the imported records as the whole dataset would empty the others.
  const next: Dataset = new Map(existing)

  for (const record of lifted.records) {
    next.set(record.mark!, record)
  }

  const changes = diffDataset(existing, next)

  if (!changes.length) {
    closeRun({
      verdict: 'Nothing changed',
      counts: [count(rows.length, 'rows', 'row'), count(0, 'changes', 'change')],
      message: ['Every record is already what the source says.'],
    })

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
    for (const one of done.diagnostics ?? []) {
      report({ glyph: 'failed', kind: 'problem', subject: one.message, fields: [field('mark', one.mark ?? '(dataset)')] })
    }

    closeRun({ verdict: 'The commit was refused' })

    return
  }

  save()

  // the commit hash is what a script captures, so it is data
  printData(`${done.commit}\n`)
  report({
    glyph: 'done',
    verb: 'commit',
    subject: `${lifted.records.length} ${input.form} record${lifted.records.length === 1 ? '' : 's'}`,
    counts: [count(lifted.minted, 'new'), count(lifted.reused, 'matched')],
    facts: [`by ${input.key ?? input.mark}`],
  })
  closeRun({ verdict: `Imported onto ${input.branch}`, counts: [count(changes.length, 'changes', 'change')] })
}
