// `term mold [file]` -- shape Term data into another shape. Reads a data file (long or compact), a compact stream
// with `--lines` (anchors re-declarable, one form per line), JSON with `--tree`, `tree/code` (told by its header
// bytes, never by a flag), or stdin, and prints it as the canonical long form, the compact one-line-per-entry form
// (`--pack`), JSON (`--json`, `--keep` leaves keys kebab), `tree/code` (`--code`, Zstandard frames where they are
// smaller, `--canonical` for the canonical uncompressed bytes), or only its diagnostics (`--check`). Never writes a file
// in place: `term form` is the in-place formatter. See note/term/host/06-package-and-cli.md and 10-code.md.
//
// The shaped data is DATA, on stdout through `printData`, byte for byte as before, so `term mold x.tree --json | jq`
// reads it clean. The run around it, and every diagnostic as a Problem item with its frame, is the human view on
// stderr (code/output.ts).

import { readFileSync } from 'fs'
import path from 'path'
import { zstdCompressSync, zstdDecompressSync } from 'zlib'
import { decodeTree, encodeTree, MAGIC } from '@term/make/code/compile/host-code'
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
import { closeRun, openRun, printBytes, printData, report, reportProblems } from '@term/call/code/output'

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
  code?: boolean
  canonical?: boolean
}): Promise<void> {
  const file = input.file ? path.resolve(input.root, input.file) : '<stdin>'
  const shape = input.check ? '--check' : input.json ? '--json' : input.pack ? '--pack' : input.code ? '--code' : 'long'

  openRun({ verb: 'mold', root: input.root, facts: [input.file ?? 'stdin', shape] })

  // binary on a terminal draws garbage and can leave it in a strange state: `tree/code` goes to a pipe or a file
  if (input.code && process.stdout.isTTY) {
    report({ glyph: 'failed', kind: 'problem', verb: 'write', subject: 'tree/code is bytes, and standard output is a terminal', message: ['send it to a file or a pipe: term mold x.tree --code > x.code'] })
    closeRun({ verdict: 'Nothing to mold' })

    return
  }

  let raw: Buffer

  try {
    raw = input.file ? readFileSync(file) : readFileSync(0)
  } catch {
    report({ glyph: 'failed', kind: 'problem', verb: 'read', subject: `${input.file ?? 'Standard input'} could not be read` })
    closeRun({ verdict: 'Nothing to mold' })

    return
  }

  const text = raw.toString('utf8')
  let data: Data
  let anchors: Map<string, DataTree> | undefined

  if (MAGIC.every((byte, at) => raw[at] === byte)) {
    // tree/code, told by its header: every frame is one value, and a stream of several is a list of them
    const decoded = decodeTree(new Uint8Array(raw), {
      decompress: (packed, size) => new Uint8Array(zstdDecompressSync(packed, { maxOutputLength: size })),
    })

    if (!decoded.ok) {
      report({ glyph: 'failed', kind: 'problem', verb: 'read', subject: `The input is not valid tree/code (${decoded.problem.name})`, message: [`${decoded.problem.message}, at byte ${decoded.problem.at}`] })
      closeRun({ verdict: 'The data does not read' })

      return
    }

    data = decoded.values.length === 1 ? (decoded.values[0] as Data) : { kind: 'list', list: decoded.values }
  } else if (input.tree || file.endsWith('.json')) {
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

  if (input.code) {
    let bytes: Uint8Array

    try {
      bytes = encodeTree(data, input.canonical ? {} : { compress: plain => new Uint8Array(zstdCompressSync(plain)) })
    } catch (error) {
      report({ glyph: 'failed', kind: 'problem', verb: 'write', subject: 'The data cannot be written as tree/code', message: [error instanceof Error ? error.message : String(error)] })
      closeRun({ verdict: 'The data does not encode' })

      return
    }

    printBytes(bytes)
  } else if (input.json) {
    printData(toJson(data, input.keep) + '\n')
  } else if (input.pack) {
    printData(writeCompact(data, anchors))
  } else {
    printData(writeLong(data, anchors))
  }

  closeRun({ verdict: 'Molded' })
}
