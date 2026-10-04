// `term move mark [1|2|3]`: bump the manifest's version. Prints through the terminal output library
// (code/output.ts): one `change` item `old → new`, and the closing verdict.

import fsp from 'fs/promises'
import path from 'path'
import {
  loadManifest,
  writeManifest,
  bumpCode,
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
    closeRun({ verdict: 'Nothing moved', next: 'term move mark [1|2|3]', failure: 'usage' })

    return
  }

  const level = parseLevel(input.level)

  try {
    const manifest = await loadManifest({ dir: input.root })
    const oldCode = showCode(manifest.mark)
    const newCode = bumpCode({ code: manifest.mark, level })
    manifest.mark = newCode

    const newCodeStr = showCode(newCode)

    const text = writeManifest({ manifest })
    await fsp.writeFile(
      path.join(input.root, 'deck.tree'),
      text,
      'utf-8',
    )

    report({ glyph: 'changed', kind: 'change', verb: 'change', subject: 'mark', facts: [`${oldCode} → ${newCodeStr}`] })
    closeRun({ verdict: `Version is ${newCodeStr}` })
  } catch (err) {
    report({ glyph: 'failed', verb: 'change', subject: 'mark', message: [err instanceof Error ? err.message : String(err)] })
    closeRun({ verdict: 'Version not moved' })
  }
}

function parseLevel(level?: string): 1 | 2 | 3 {
  if (!level || level === '3') {
    return 3
  }

  if (level === '2') {
    return 2
  }

  if (level === '1') {
    return 1
  }

  return 3
}
