// `term mold [file]` -- shape Term data into another shape. Reads a data file (long or compact), a compact stream
// with `--lines` (anchors re-declarable, one form per line), or JSON with `--tree`, or stdin, and prints it as the
// canonical long form, the compact one-line-per-entry form (`--pack`), JSON (`--json`, `--keep` leaves keys
// kebab), or only its diagnostics (`--check`). Never writes a file in place:
// `term form` is the in-place formatter. See note/term/host/06-package-and-cli.md.

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
import { renderDiagnostic } from '@term/call/code/report'
import { logFail } from '@term/make/code/tint'

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

  let text: string

  try {
    text = input.file
      ? readFileSync(file, 'utf8')
      : readFileSync(0, 'utf8')
  } catch {
    logFail(`Could not read ${input.file ?? 'stdin'}`)
    process.exit(1)
  }

  let data: Data
  let anchors: Map<string, DataTree> | undefined

  if (input.tree || file.endsWith('.json')) {
    try {
      data = fromJson(text)
    } catch (error) {
      logFail(`Not JSON: ${String(error)}`)
      process.exit(1)
    }
  } else if (input.lines) {
    // a stream: one form per line, anchors re-declarable, each line expanded as it is read
    const stream = readStream({ file, text })

    if (!stream.ok) {
      for (const diagnostic of stream.diagnostics) {
        console.error(renderDiagnostic(diagnostic, text))
      }

      process.exit(1)
    }

    if (input.check) {
      return
    }

    data = stream.data
  } else {
    const read = readDataText({ file, text })

    if (!read.ok) {
      for (const diagnostic of read.diagnostics) {
        console.error(renderDiagnostic(diagnostic, text))
      }

      process.exit(1)
    }

    if (input.check) {
      const expanded = expandData(read.data, file)

      if (!expanded.ok) {
        for (const diagnostic of expanded.diagnostics) {
          console.error(renderDiagnostic(diagnostic, text))
        }

        process.exit(1)
      }

      return
    }

    // `--trees` keeps the anchors as written; the default expands them, so the output is plain data
    if (input.trees) {
      data = read.data.root
      anchors = read.data.trees
    } else {
      const expanded = expandData(read.data, file)

      if (!expanded.ok) {
        for (const diagnostic of expanded.diagnostics) {
          console.error(renderDiagnostic(diagnostic, text))
        }

        process.exit(1)
      }

      data = expanded.data
    }
  }

  if (input.check) {
    return
  }

  if (input.json) {
    process.stdout.write(toJson(data, input.keep) + '\n')
  } else if (input.pack) {
    process.stdout.write(writeCompact(data, anchors))
  } else {
    process.stdout.write(writeLong(data, anchors))
  }
}
