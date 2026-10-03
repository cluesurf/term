import fsp from 'fs/promises'
import path from 'path'
import {
  loadManifest,
  writeManifest,
  bumpCode,
  showCode,
} from '@cluesurf/deck.tree'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  name,
  mark as markColor,
} from '@term/make/code/tint'

export async function callMove(input: {
  root: string
  target?: string
  level?: string
}): Promise<void> {
  // the target names the manifest field that moves: `mark`, the version. `code` is its old spelling (the version
  // was `code <...>` until `code` came to name the code root), still taken so a script written against it works
  if (input.target !== 'mark' && input.target !== 'code') {
    logFail(
      `Unknown move target: ${input.target}. Use: term move mark [1|2|3]`,
    )
    process.exit(1)
  }

  const level = parseLevel(input.level)

  logStep('Bumping version...')

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

    logGood(
      `Version bumped: ${markColor(oldCode)} → ${markColor(
        newCodeStr,
      )}`,
    )
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
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
