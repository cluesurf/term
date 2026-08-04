import { loadManifest, showCode } from '@cluesurf/deck.tree'
import chalk from 'chalk'
import {
  logFail,
  formatError,
  name,
  mark as markColor,
  fade,
} from '@term/make/code/tint'

export async function callNote(input: {
  root: string
  deck?: string
}): Promise<void> {
  try {
    const manifest = await loadManifest({ dir: input.root })
    const fullName = manifest.host
      ? `@${manifest.host}/${manifest.name}`
      : manifest.name

    console.log('')
    console.log(
      '  ' +
        chalk.bold(name(fullName)) +
        ' ' +
        markColor(showCode(manifest.code)),
    )

    if (manifest.head) {
      console.log('  ' + manifest.head)
    }

    if (manifest.lock) {
      console.log('  License: ' + manifest.lock)
    }

    if (manifest.mind && manifest.mind.length > 0) {
      console.log(
        '  Authors: ' + manifest.mind.map(f => f.name).join(', '),
      )
    }

    if (manifest.link.length > 0) {
      console.log('')
      console.log(chalk.bold('  Dependencies:'))

      for (const dep of manifest.link) {
        console.log('    ' + name(dep.name))
      }
    }

    console.log('')
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
