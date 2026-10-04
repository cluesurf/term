// `term mold [file]` -- shape Term data into another shape. Reads a data file (long or compact), a compact stream
// with `--lines` (anchors re-declarable, one form per line), or JSON with `--tree`, or stdin, and prints it as the
// canonical long form, the compact one-line-per-entry form (`--pack`), JSON (`--json`, `--keep` leaves keys
// kebab), or only its diagnostics (`--check`). Never writes a file in place:
// `term form` is the in-place formatter. See note/term/host/06-package-and-cli.md.
//
// The shaped data is DATA, on stdout through `printData`, byte for byte as before, so `term mold x.tree --json | jq`
// reads it clean. The run around it, and every diagnostic as a Problem item with its frame, is the human view on
// stderr (code/output.ts).

import { readFileSync } from 'fs'
import path from 'path'
import {
  expandData,
  fromJson,
  readDataText,
  readStream,
  toJson,
  writeCompact,
  writeLong,
} from '@term/make/code/compile/host'
import type { Data, DataTree } from '@term/make/code/compile/host'
import type { Diagnostic } from '@term/make/code/parser/diagnostic'
import { closeRun, openRun, printData, report, reportProblems } from '@term/call/code/output'

// the run ends on the data's own defects, each with its frame
function refuse(diagnostics: Diagnostic[], text: string, root: string): void {
  reportProblems(diagnostics.map(diagnostic => ({ diagnostic, text })), root)
  closeRun({ verdict: 'The data does not read' })
}

export async function callMold(input: {
  root: string
  file?: string
  pack?: boolean
  json?: boolean
  keep?: boolean
  tree?: boolean
  check?: boolean
  trees?: boolean
  lines?: boolean
}): Promise<void> {
  const file = input.file ? path.resolve(input.root, input.file) : '<stdin>'
  const shape = input.check ? '--check' : input.json ? '--json' : input.pack ? '--pack' : 'long'

  openRun({ verb: 'mold', root: input.root, facts: [input.file ?? 'stdin', shape] })

  let text: string

  try {
    text = input.file
      ? readFileSync(file, 'utf8')
      : readFileSync(0, 'utf8')
  } catch {
    report({ glyph: 'failed', kind: 'problem', verb: 'read', subject: `${input.file ?? 'Standard input'} could not be read` })
    closeRun({ verdict: 'Nothing to mold' })

    return
  }

  let data: Data
  let anchors: Map<string, DataTree> | undefined

  if (input.tree || file.endsWith('.json')) {
    try {
      data = fromJson(text)
    } catch (error) {
      report({ glyph: 'failed', kind: 'problem', verb: 'read', subject: 'The input is not JSON', message: [error instanceof Error ? error.message : String(error)] })
      closeRun({ verdict: 'The data does not read' })

      return
    }
  } else if (input.lines) {
    // a stream: one form per line, anchors re-declarable, each line expanded as it is read
    const stream = readStream({ file, text })

    if (!stream.ok) {
      refuse(stream.diagnostics, text, input.root)

      return
    }

    if (input.check) {
      closeRun({ verdict: 'The data reads' })

      return
    }

    data = stream.data
  } else {
    const read = readDataText({ file, text })

    if (!read.ok) {
      refuse(read.diagnostics, text, input.root)

      return
    }

    if (input.check) {
      const expanded = expandData(read.data, file)

      if (!expanded.ok) {
        refuse(expanded.diagnostics, text, input.root)

        return
      }

      closeRun({ verdict: 'The data reads' })

      return
    }

    // `--trees` keeps the anchors as written; the default expands them, so the output is plain data
    if (input.trees) {
      data = read.data.root
      anchors = read.data.trees
    } else {
      const expanded = expandData(read.data, file)

      if (!expanded.ok) {
        refuse(expanded.diagnostics, text, input.root)

        return
      }

      data = expanded.data
    }
  }

  if (input.check) {
    closeRun({ verdict: 'The data reads' })

    return
  }

  if (input.json) {
    printData(toJson(data, input.keep) + '\n')
  } else if (input.pack) {
    printData(writeCompact(data, anchors))
  } else {
    printData(writeLong(data, anchors))
  }

  closeRun({ verdict: 'Molded' })
}
