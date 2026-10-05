// `term show [mark]`: the toolchain's version and platform, or the project's version. Each is the answer itself, so it
// is data on stdout (`printData`), and `--back json` prints it as one JSON object instead of the block.
//
// Four things a guide found on 2026-10-04 (guides: commands/show), each held by test/call/exit-codes.ts:
//
// - `term show mark` reads the NEAREST deck.tree, this folder or a parent, the way every other command finds its
//   project. From a project's `code/` folder it said there was no deck.tree.
// - a deck.tree that is there and cannot be read says so, with the reader's message. It said there was none.
// - `--back json` was accepted and changed nothing.
// - an argument it does not know is refused, exit 2. It printed the toolchain as though none had been given.

import fs from 'fs'
import os from 'os'
import path from 'path'
import { infoText } from '@term/make/code/show'
import { closeRun, field, openRun, printData, report, showPath } from '@term/call/code/output'

export async function callShow(input: {
  root: string
  what?: string
  back?: string
  version: string
}): Promise<void> {
  const json = input.back === 'json'

  if (input.what === undefined) {
    printData(
      json
        ? `${JSON.stringify({ term: input.version, platform: os.platform(), arch: os.arch(), node: process.version, home: os.homedir() })}\n`
        : infoText(input.version),
    )

    return
  }

  if (input.what !== 'mark' && input.what !== 'code') {
    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: `There is nothing named ${input.what} to show` })
    closeRun({ verdict: 'Nothing shown', next: 'term show, or term show mark', failure: 'usage' })

    return
  }

  const manifest = nearestManifest(input.root)

  if (!manifest) {
    openRun({ verb: 'show', root: input.root })
    report({ glyph: 'failed', kind: 'problem', subject: 'There is no deck.tree here or above', fields: [field('looked', showPath(input.root))] })
    closeRun({ verdict: 'No version to show', next: 'term wake, to make a project here' })

    return
  }

  const { loadManifest, showCode } = await import('@cluesurf/deck.tree')

  try {
    const read = await loadManifest({ dir: path.dirname(manifest) })
    const mark = showCode(read.mark)

    printData(json ? `${JSON.stringify({ mark })}\n` : `${mark}\n`)
  } catch (error) {
    openRun({ verb: 'show', root: input.root })
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: 'The deck.tree could not be read',
      fields: [field('at', showPath(manifest))],
      message: [error instanceof Error ? error.message : String(error)],
    })
    closeRun({ verdict: 'No version to show' })
  }
}

// the deck.tree in `from` or the nearest folder above it
function nearestManifest(from: string): string | undefined {
  for (let dir = path.resolve(from); ; dir = path.dirname(dir)) {
    const file = path.join(dir, 'deck.tree')

    if (fs.existsSync(file)) {
      return file
    }

    if (path.dirname(dir) === dir) {
      return undefined
    }
  }
}
