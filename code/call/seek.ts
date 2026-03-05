import { verifyInstall } from '@cluesurf/deck.tree'
import { logGood, logFail, logWarn, formatError, name, fade } from '../tint'

export async function callSeek(input: {
  root: string
}): Promise<void> {
  try {
    const result = await verifyInstall({ root: input.root })

    if (result.ok) {
      logGood('All packages are installed correctly')
      return
    }

    if (result.missing.length > 0) {
      logWarn('Missing packages:')
      for (const pkg of result.missing) {
        console.log(`    ${name(pkg)}`)
      }
    }

    if (result.outdated.length > 0) {
      logWarn('Outdated packages:')
      for (const pkg of result.outdated) {
        console.log(`    ${name(pkg)}`)
      }
    }

    console.log('')
    console.log(fade('  Run `seed load` to fix.'))
    process.exit(1)
  } catch (err) {
    logFail(formatError(err))
    process.exit(1)
  }
}
