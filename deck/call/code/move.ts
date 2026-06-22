import fsp from 'fs/promises'
import path from 'path'
import {
  loadManifest,
  writeManifest,
  bumpMark,
  showMark,
} from '@cluesurf/deck.tree'
import {
  logGood,
  logFail,
  logStep,
  formatError,
  name,
  mark as markColor,
} from '@cluesurf/make/code/tint'

export async function callMove(input: {
  root: string
  target?: string
  level?: string
}): Promise<void> {
  if (input.target !== 'mark') {
    logFail(
      `Unknown move target: ${input.target}. Use: seed move mark [1|2|3]`,
    )
    process.exit(1)
  }

  const level = parseLevel(input.level)

  logStep('Bumping version...')

  try {
    const manifest = await loadManifest({ dir: input.root })
    const oldMark = showMark(manifest.mark)
    const newMark = bumpMark({ mark: manifest.mark, level })
    manifest.mark = newMark

    const newMarkStr = showMark(newMark)

    const text = writeManifest({ manifest })
    await fsp.writeFile(
      path.join(input.root, 'deck.tree'),
      text,
      'utf-8',
    )

    logGood(
      `Version bumped: ${markColor(oldMark)} → ${markColor(
        newMarkStr,
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
