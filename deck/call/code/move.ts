// `term move mark [1|2|3|rc]`: bump the manifest's version, or start or move a pre-release named by a word. Prints through the terminal output library
// (code/output.ts): one `change` item `old → new`, and the closing verdict.

import fsp from 'fs/promises'
import path from 'path'
import {
  loadManifest,
  writeManifest,
  bumpCode,
  bumpPrerelease,
  showCode,
} from '@cluesurf/deck.tree'
import { closeRun, openRun, report } from '@term/call/code/output'

export async function callMove(input: {
  root: string
  target?: string
  level?: string
}): Promise<void> {
  openRun({ verb: 'move', root: input.root })

  // the target names the manifest field that moves: `mark`, the version. `code` is its old spelling (the version
  // was `code <...>` until `code` came to name the code root), still taken so a script written against it works
  if (input.target !== 'mark' && input.target !== 'code') {
    report({ glyph: 'failed', kind: 'problem', subject: `There is nothing named ${input.target ?? 'that'} to move` })
    closeRun({ verdict: 'Nothing moved', next: USAGE, failure: 'usage' })

    return
  }

  const level = parseLevel(input.level)

  if (level === undefined) {
    report({
      glyph: 'failed',
      kind: 'problem',
      subject: `${input.level} is not a part of the version`,
      message: ['1, 2 or 3 moves the major, minor or patch, and a word such as rc starts or moves a pre-release'],
    })
    closeRun({ verdict: 'Nothing moved', next: USAGE, failure: 'usage' })

    return
  }

  try {
    const manifest = await loadManifest({ dir: input.root })
    const oldCode = showCode(manifest.mark)
    const newCode =
      typeof level === 'number' ? bumpCode({ code: manifest.mark, level }) : bumpPrerelease({ code: manifest.mark, id: level })
    manifest.mark = newCode

    const newCodeStr = showCode(newCode)

    const text = writeManifest({ manifest })
    await fsp.writeFile(
      path.join(input.root, 'deck.tree'),
      text,
      'utf-8',
    )

    report({ glyph: 'changed', kind: 'change', verb: 'change', subject: 'mark', facts: [`${oldCode} → ${newCodeStr}`] })
    closeRun({ verdict: `Version is ${newCodeStr}`, done: true })
  } catch (err) {
    report({ glyph: 'failed', verb: 'change', subject: 'mark', message: [err instanceof Error ? err.message : String(err)] })
    closeRun({ verdict: 'Version not moved' })
  }
}

const USAGE = 'term move mark [1|2|3|rc]'

// 1, 2 or 3, or the name of a pre-release (`rc`, `beta`). Anything else moved the patch without a word
function parseLevel(level?: string): 1 | 2 | 3 | string | undefined {
  if (!level || level === '3') {
    return 3
  }

  if (level === '2') {
    return 2
  }

  if (level === '1') {
    return 1
  }

  return /^[A-Za-z][0-9A-Za-z-]*$/.test(level) ? level : undefined
}
